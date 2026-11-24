import crypto from 'crypto';
import {db} from './db.ts';
import {
  downloadTrackToNas,
  findLibraryTrackByVideoId,
  getYoutubePlaylistDetail,
  isValidYouTubePlaylistId,
} from './downloader.ts';

const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CONCURRENT_PER_JOB = 2;
const RETRY_DELAY_MS = 1500;
const MAX_ATTEMPTS_PER_TRACK = 2; // initial try + 1 retry

export type PlaylistDownloadJobState = 'running' | 'completed' | 'cancelled' | 'failed';
export type PlaylistDownloadItemStatus = 'pending' | 'downloading' | 'done' | 'failed' | 'cancelled';

export interface PlaylistJobFailedTrack {
  position: number;
  videoId: string;
  title: string;
  artist: string;
  error: string;
}

export interface PlaylistJobTrackItemView {
  position: number;
  videoId: string;
  title: string;
  artist: string;
  channel: string;
  duration: number;
  thumbnail: string;
  status: PlaylistDownloadItemStatus;
  trackId: number | null;
  error: string;
}

export interface PlaylistDownloadJobView {
  id: string;
  jobId: string;
  userId: number;
  playlistId: number;
  youtubePlaylistId: string;
  playlistName: string;
  state: PlaylistDownloadJobState;
  total: number;
  done: number;
  failed: number;
  failedTracks: PlaylistJobFailedTrack[];
  items?: PlaylistJobTrackItemView[];
  createdAt: string;
  updatedAt: string;
}

interface JobRow {
  id: string;
  user_id: number;
  playlist_id: number;
  youtube_playlist_id: string;
  playlist_name: string;
  state: PlaylistDownloadJobState;
  total: number;
  done: number;
  failed: number;
  created_at: string;
  updated_at: string;
}

interface JobItemRow {
  id: number;
  job_id: string;
  position: number;
  video_id: string;
  title: string;
  artist: string;
  channel: string;
  duration: number;
  thumbnail: string;
  status: PlaylistDownloadItemStatus;
  track_id: number | null;
  error: string;
  attempts: number;
}

const activeJobRunners = new Set<string>();
const cancelledJobIds = new Set<string>();

export function isValidPlaylistJobId(jobId: string | null | undefined): boolean {
  return Boolean(jobId && JOB_ID_RE.test(jobId.trim()));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function linkTrackToPlaylistAtPosition(playlistId: number, trackId: number, position: number): void {
  const existing = db
    .prepare('SELECT id FROM playlist_tracks WHERE playlist_id = ? AND track_id = ? LIMIT 1')
    .get(playlistId, trackId) as {id: number} | undefined;
  if (existing) return;

  db.prepare(
    'INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)'
  ).run(playlistId, trackId, position);
  db.prepare("UPDATE playlists SET updated_at = datetime('now') WHERE id = ?").run(playlistId);
}

function recalculateJobCounters(jobId: string): {
  total: number;
  done: number;
  failed: number;
  pendingOrActive: number;
} {
  const rows = db
    .prepare(
      `SELECT status, COUNT(*) as count
       FROM youtube_playlist_job_items
       WHERE job_id = ?
       GROUP BY status`
    )
    .all(jobId) as Array<{status: PlaylistDownloadItemStatus; count: number}>;

  let total = 0;
  let done = 0;
  let failed = 0;
  let pendingOrActive = 0;
  for (const r of rows) {
    total += r.count;
    if (r.status === 'done') done += r.count;
    else if (r.status === 'failed') failed += r.count;
    else if (r.status === 'pending' || r.status === 'downloading') pendingOrActive += r.count;
  }

  db.prepare(
    `UPDATE youtube_playlist_jobs
     SET total = ?, done = ?, failed = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(total, done, failed, jobId);

  return {total, done, failed, pendingOrActive};
}

function mapJobToView(row: JobRow, includeItems: boolean): PlaylistDownloadJobView {
  const failedRows = db
    .prepare(
      `SELECT position, video_id, title, artist, error
       FROM youtube_playlist_job_items
       WHERE job_id = ? AND status = 'failed'
       ORDER BY position ASC`
    )
    .all(row.id) as Array<{
    position: number;
    video_id: string;
    title: string;
    artist: string;
    error: string;
  }>;

  const view: PlaylistDownloadJobView = {
    id: row.id,
    jobId: row.id,
    userId: row.user_id,
    playlistId: row.playlist_id,
    youtubePlaylistId: row.youtube_playlist_id,
    playlistName: row.playlist_name,
    state: row.state,
    total: row.total,
    done: row.done,
    failed: row.failed,
    failedTracks: failedRows.map((f) => ({
      position: f.position,
      videoId: f.video_id,
      title: f.title,
      artist: f.artist,
      error: f.error,
    })),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

  if (includeItems) {
    const itemRows = db
      .prepare(
        `SELECT position, video_id, title, artist, channel, duration, thumbnail, status, track_id, error
         FROM youtube_playlist_job_items
         WHERE job_id = ?
         ORDER BY position ASC`
      )
      .all(row.id) as Array<Omit<JobItemRow, 'id' | 'job_id' | 'attempts'>>;

    view.items = itemRows.map((item) => ({
      position: item.position,
      videoId: item.video_id,
      title: item.title,
      artist: item.artist,
      channel: item.channel,
      duration: item.duration,
      thumbnail: item.thumbnail,
      status: item.status,
      trackId: item.track_id,
      error: item.error,
    }));
  }

  return view;
}

function isJobCancelled(jobId: string): boolean {
  if (cancelledJobIds.has(jobId)) return true;
  const row = db
    .prepare('SELECT state FROM youtube_playlist_jobs WHERE id = ?')
    .get(jobId) as {state: PlaylistDownloadJobState} | undefined;
  if (!row || row.state === 'cancelled') {
    cancelledJobIds.add(jobId);
    return true;
  }
  return false;
}

function playlistStillExists(playlistId: number): boolean {
  const row = db.prepare('SELECT id FROM playlists WHERE id = ?').get(playlistId) as
    | {id: number}
    | undefined;
  return Boolean(row);
}

async function processPlaylistJobItem(job: JobRow, item: JobItemRow): Promise<void> {
  if (isJobCancelled(job.id) || !playlistStillExists(job.playlist_id)) {
    db.prepare(
      "UPDATE youtube_playlist_job_items SET status = 'cancelled' WHERE id = ? AND status IN ('pending', 'downloading')"
    ).run(item.id);
    return;
  }

  // Dedupe by videoId first: if already downloaded in the library, just link to playlist
  const existingTrack = findLibraryTrackByVideoId(item.video_id);
  if (existingTrack) {
    if (playlistStillExists(job.playlist_id)) {
      linkTrackToPlaylistAtPosition(job.playlist_id, existingTrack.id, item.position);
    }
    db.prepare(
      "UPDATE youtube_playlist_job_items SET status = 'done', track_id = ?, error = '' WHERE id = ?"
    ).run(existingTrack.id, item.id);
    recalculateJobCounters(job.id);
    return;
  }

  db.prepare(
    "UPDATE youtube_playlist_job_items SET status = 'downloading', error = '' WHERE id = ?"
  ).run(item.id);

  let lastError = 'Download failed';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_TRACK; attempt++) {
    if (isJobCancelled(job.id) || !playlistStillExists(job.playlist_id)) {
      db.prepare(
        "UPDATE youtube_playlist_job_items SET status = 'cancelled' WHERE id = ? AND status = 'downloading'"
      ).run(item.id);
      return;
    }

    db.prepare('UPDATE youtube_playlist_job_items SET attempts = ? WHERE id = ?').run(
      attempt,
      item.id
    );

    try {
      const result = await downloadTrackToNas({
        userId: job.user_id,
        videoId: item.video_id,
        url: `https://www.youtube.com/watch?v=${item.video_id}`,
        title: item.title,
        artist: item.artist || item.channel || 'Unknown Artist',
        album: job.playlist_name,
        coverUrl: item.thumbnail,
        duration: item.duration,
      });

      const trackId = result.track.id;
      if (playlistStillExists(job.playlist_id)) {
        linkTrackToPlaylistAtPosition(job.playlist_id, trackId, item.position);
      }

      db.prepare(
        "UPDATE youtube_playlist_job_items SET status = 'done', track_id = ?, error = '' WHERE id = ?"
      ).run(trackId, item.id);
      recalculateJobCounters(job.id);
      return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < MAX_ATTEMPTS_PER_TRACK && !isJobCancelled(job.id)) {
        await delay(RETRY_DELAY_MS);
      }
    }
  }

  if (isJobCancelled(job.id)) {
    db.prepare(
      "UPDATE youtube_playlist_job_items SET status = 'cancelled' WHERE id = ? AND status = 'downloading'"
    ).run(item.id);
  } else {
    db.prepare(
      "UPDATE youtube_playlist_job_items SET status = 'failed', error = ? WHERE id = ?"
    ).run(lastError.slice(0, 300), item.id);
  }
  recalculateJobCounters(job.id);
}

function claimNextPendingItem(jobId: string): JobItemRow | null {
  if (isJobCancelled(jobId)) return null;
  const next = db
    .prepare(
      `SELECT *
       FROM youtube_playlist_job_items
       WHERE job_id = ? AND status = 'pending'
       ORDER BY position ASC
       LIMIT 1`
    )
    .get(jobId) as JobItemRow | undefined;
  if (!next) return null;

  const info = db
    .prepare(
      "UPDATE youtube_playlist_job_items SET status = 'downloading' WHERE id = ? AND status = 'pending'"
    )
    .run(next.id);
  if (info.changes === 0) return null;

  return {...next, status: 'downloading'};
}

function runPlaylistJob(jobId: string): void {
  if (activeJobRunners.has(jobId)) return;
  activeJobRunners.add(jobId);

  void (async () => {
    try {
      const job = db
        .prepare('SELECT * FROM youtube_playlist_jobs WHERE id = ?')
        .get(jobId) as JobRow | undefined;
      if (!job || job.state !== 'running') return;

      const worker = async () => {
        while (true) {
          if (isJobCancelled(jobId) || !playlistStillExists(job.playlist_id)) {
            return;
          }
          const item = claimNextPendingItem(jobId);
          if (!item) return;
          await processPlaylistJobItem(job, item);
        }
      };

      const workers = Array.from({length: MAX_CONCURRENT_PER_JOB}, () => worker());
      await Promise.all(workers);

      const finalCounts = recalculateJobCounters(jobId);
      const cancelled = isJobCancelled(jobId);
      if (cancelled) {
        db.prepare(
          "UPDATE youtube_playlist_job_items SET status = 'cancelled' WHERE job_id = ? AND status IN ('pending', 'downloading')"
        ).run(jobId);
        db.prepare(
          "UPDATE youtube_playlist_jobs SET state = 'cancelled', updated_at = datetime('now') WHERE id = ?"
        ).run(jobId);
      } else {
        const finalState: PlaylistDownloadJobState =
          finalCounts.total > 0 && finalCounts.done === 0 && finalCounts.failed === finalCounts.total
            ? 'failed'
            : 'completed';
        db.prepare(
          "UPDATE youtube_playlist_jobs SET state = ?, updated_at = datetime('now') WHERE id = ?"
        ).run(finalState, jobId);
      }
    } catch (err) {
      console.error('[playlist-download-job]', jobId, err);
      db.prepare(
        "UPDATE youtube_playlist_jobs SET state = 'failed', updated_at = datetime('now') WHERE id = ? AND state = 'running'"
      ).run(jobId);
    } finally {
      activeJobRunners.delete(jobId);
      cancelledJobIds.delete(jobId);
    }
  })();
}

export async function startYouTubePlaylistDownload(params: {
  userId: number;
  youtubePlaylistId: string;
  name: string;
}): Promise<{
  job: PlaylistDownloadJobView;
  playlist: Record<string, unknown>;
}> {
  const playlistIdStr = (params.youtubePlaylistId || '').trim();
  if (!isValidYouTubePlaylistId(playlistIdStr)) {
    throw new Error('Invalid playlist ID');
  }

  const cleanName = (params.name || '').replace(/[\r\n]/g, '').trim().slice(0, 100);
  if (!cleanName) {
    throw new Error('Playlist name is required');
  }

  // Re-fetch authoritative track list (capped at 200 inside getYoutubePlaylistDetail)
  const detail = await getYoutubePlaylistDetail(playlistIdStr, {forceRefresh: false});
  if (!detail.tracks || detail.tracks.length === 0) {
    throw new Error('No playable tracks found in this playlist');
  }

  const description = detail.channel
    ? `YouTube · ${detail.channel}`.slice(0, 300)
    : 'Downloaded from YouTube';

  const jobId = crypto.randomUUID();

  const created = db.transaction(() => {
    // Create using the exact same mechanism as existing user-created playlists (source = 'manual')
    const plInfo = db
      .prepare('INSERT INTO playlists (user_id, name, description) VALUES (?, ?, ?)')
      .run(params.userId, cleanName, description);
    const playlistId = Number(plInfo.lastInsertRowid);

    const total = detail.tracks.length;
    let initialDone = 0;

    db.prepare(
      `INSERT INTO youtube_playlist_jobs
         (id, user_id, playlist_id, youtube_playlist_id, playlist_name, state, total, done, failed)
       VALUES (?, ?, ?, ?, ?, 'running', ?, 0, 0)`
    ).run(jobId, params.userId, playlistId, playlistIdStr, cleanName, total);

    const insertItem = db.prepare(
      `INSERT INTO youtube_playlist_job_items
         (job_id, position, video_id, title, artist, channel, duration, thumbnail, status, track_id, error, attempts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 0)`
    );

    // Pre-link tracks already in the library (deduped by videoId) immediately at their original position
    for (let i = 0; i < detail.tracks.length; i++) {
      const t = detail.tracks[i];
      const existing = findLibraryTrackByVideoId(t.videoId);
      if (existing) {
        linkTrackToPlaylistAtPosition(playlistId, existing.id, i);
        insertItem.run(
          jobId,
          i,
          t.videoId,
          t.title,
          t.artist || t.channel || 'Unknown Artist',
          t.channel || '',
          t.duration || 0,
          t.thumbnail || '',
          'done',
          existing.id
        );
        initialDone += 1;
      } else {
        insertItem.run(
          jobId,
          i,
          t.videoId,
          t.title,
          t.artist || t.channel || 'Unknown Artist',
          t.channel || '',
          t.duration || 0,
          t.thumbnail || '',
          'pending',
          null
        );
      }
    }

    const initialState: PlaylistDownloadJobState =
      initialDone === total ? 'completed' : 'running';
    db.prepare(
      `UPDATE youtube_playlist_jobs
       SET done = ?, state = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(initialDone, initialState, jobId);

    const playlistRow = db
      .prepare(
        `SELECT p.*, u.username AS owner_username
         FROM playlists p
         LEFT JOIN users u ON u.id = p.user_id
         WHERE p.id = ?`
      )
      .get(playlistId) as Record<string, unknown>;

    const covers = (
      db
        .prepare(
          `SELECT DISTINCT t.cover_file
           FROM playlist_tracks pt
           JOIN tracks t ON t.id = pt.track_id
           WHERE pt.playlist_id = ? AND t.cover_file IS NOT NULL
           ORDER BY pt.position ASC, pt.id ASC
           LIMIT 4`
        )
        .all(playlistId) as Array<{cover_file: string}>
    ).map((c) => c.cover_file);

    const jobRow = db
      .prepare('SELECT * FROM youtube_playlist_jobs WHERE id = ?')
      .get(jobId) as JobRow;

    return {
      playlist: {...playlistRow, covers, track_count: initialDone},
      jobRow,
    };
  })();

  if (created.jobRow.state === 'running') {
    runPlaylistJob(jobId);
  }

  return {
    job: mapJobToView(created.jobRow, true),
    playlist: created.playlist,
  };
}

export function getPlaylistDownloadJobForUser(
  jobId: string,
  userId: number,
  role: string,
  includeItems = true
): {status: 'ok'; job: PlaylistDownloadJobView} | {status: 'not_found'} | {status: 'forbidden'} {
  const row = db
    .prepare('SELECT * FROM youtube_playlist_jobs WHERE id = ?')
    .get(jobId) as JobRow | undefined;
  if (!row) return {status: 'not_found'};
  if (row.user_id !== userId && role !== 'admin') return {status: 'forbidden'};
  return {status: 'ok', job: mapJobToView(row, includeItems)};
}

export function listPlaylistDownloadJobsForUser(
  userId: number,
  role: string
): PlaylistDownloadJobView[] {
  const rows = (
    role === 'admin'
      ? db
          .prepare(
            `SELECT *
             FROM youtube_playlist_jobs
             WHERE state = 'running'
                OR updated_at >= datetime('now', '-24 hours')
             ORDER BY created_at DESC
             LIMIT 50`
          )
          .all()
      : db
          .prepare(
            `SELECT *
             FROM youtube_playlist_jobs
             WHERE user_id = ?
               AND (state = 'running' OR updated_at >= datetime('now', '-24 hours'))
             ORDER BY created_at DESC
             LIMIT 50`
          )
          .all(userId)
  ) as JobRow[];

  return rows.map((row) => mapJobToView(row, false));
}

export function cancelPlaylistDownloadJobForUser(
  jobId: string,
  userId: number,
  role: string
): {status: 'ok'; job: PlaylistDownloadJobView} | {status: 'not_found'} | {status: 'forbidden'} {
  const row = db
    .prepare('SELECT * FROM youtube_playlist_jobs WHERE id = ?')
    .get(jobId) as JobRow | undefined;
  if (!row) return {status: 'not_found'};
  if (row.user_id !== userId && role !== 'admin') return {status: 'forbidden'};

  if (row.state === 'running') {
    cancelledJobIds.add(jobId);
    db.prepare(
      "UPDATE youtube_playlist_job_items SET status = 'cancelled' WHERE job_id = ? AND status = 'pending'"
    ).run(jobId);
    db.prepare(
      "UPDATE youtube_playlist_jobs SET state = 'cancelled', updated_at = datetime('now') WHERE id = ?"
    ).run(jobId);
    recalculateJobCounters(jobId);
  }

  const updated = db
    .prepare('SELECT * FROM youtube_playlist_jobs WHERE id = ?')
    .get(jobId) as JobRow;
  return {status: 'ok', job: mapJobToView(updated, true)};
}

export function resumePendingPlaylistDownloadJobs(): void {
  const runningJobs = db
    .prepare("SELECT id FROM youtube_playlist_jobs WHERE state = 'running'")
    .all() as Array<{id: string}>;

  for (const job of runningJobs) {
    // Reset any interrupted mid-flight tracks back to pending so workers pick them up cleanly
    db.prepare(
      "UPDATE youtube_playlist_job_items SET status = 'pending' WHERE job_id = ? AND status = 'downloading'"
    ).run(job.id);
    runPlaylistJob(job.id);
  }
}

// Resume any interrupted jobs automatically when the server boots
resumePendingPlaylistDownloadJobs();
