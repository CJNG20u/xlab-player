import {spawn} from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {AUDIO_CACHE_DIR, db, getFfmpegPath} from './db.ts';
import {
  deleteTrackVideoMapEntry,
  getMatchedVideoOrigins,
  isResolverQueueBusy,
  isValidYouTubeVideoId,
  upsertTrackVideoMapEntry,
  type MatchedVideoOrigin,
} from './downloader.ts';

// ---------------------------------------------------------------------------
// Phase 2: One-Pass EBU R128 Measurement & Auto-Rejection of Broken Matches
// ---------------------------------------------------------------------------

export const LEVEL_DROP_DB = 12;
export const MIN_RUN_PCT = 25;
export const MIN_RUN_SECONDS = 20;
export const EDGE_IGNORE_SECONDS = 8;
export const SILENT_LUFS_THRESHOLD = -50;
export const SILENT_TRUE_PEAK_THRESHOLD = -45;
export const MAX_BAD_CANDIDATES_PER_TRACK = 2;

const MAX_PENDING_JOBS = 200;
const FFMPEG_MEASURE_TIMEOUT_MS = 90_000;
const BUSY_RETRY_DELAY_MS = 5_000;

export type AudioQcStatus = 'ok' | 'bad';
export type AudioQcReason = '' | 'silent' | 'level-drop' | 'duration';

export interface MomentarySample {
  t: number;
  m: number;
}

export interface VideoAudioFactsRow {
  videoId: string;
  lufs: number | null;
  truePeakDb: number | null;
  durationSec: number;
  lowRunPct: number;
  status: AudioQcStatus;
  reason: string;
  measuredAt: number;
}

export interface TrackVideoRejectRow {
  trackKey: string;
  videoId: string;
  reason: string;
  createdAt: number;
}

export interface AudioQcSummary {
  total: number;
  ok: number;
  bad: number;
  badByReason: Record<string, number>;
  recentRejections: TrackVideoRejectRow[];
}

export interface Ebur128Measurement {
  lufs: number | null;
  truePeakDb: number | null;
  durationSec: number;
  samples: MomentarySample[];
}

const getFactsStmt = db.prepare(
  'SELECT videoId, lufs, truePeakDb, durationSec, lowRunPct, status, reason, measuredAt FROM video_audio_facts WHERE videoId = ?'
);
const insertFactsStmt = db.prepare(
  `INSERT OR IGNORE INTO video_audio_facts
     (videoId, lufs, truePeakDb, durationSec, lowRunPct, status, reason, measuredAt)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
);
const getTrackRejectsStmt = db.prepare(
  'SELECT trackKey, videoId, reason, createdAt FROM track_video_rejects WHERE trackKey = ? ORDER BY createdAt ASC'
);
const insertTrackRejectStmt = db.prepare(
  `INSERT OR IGNORE INTO track_video_rejects (trackKey, videoId, reason, createdAt)
   VALUES (?, ?, ?, ?)`
);
const deleteTrackRejectStmt = db.prepare(
  'DELETE FROM track_video_rejects WHERE trackKey = ? AND videoId = ?'
);
const getQcStatusCountsStmt = db.prepare(
  'SELECT status, reason, COUNT(*) AS cnt FROM video_audio_facts GROUP BY status, reason'
);
const getRecentRejectionsStmt = db.prepare(
  'SELECT trackKey, videoId, reason, createdAt FROM track_video_rejects ORDER BY createdAt DESC LIMIT 20'
);

export function getVideoAudioFacts(videoId: string): VideoAudioFactsRow | null {
  if (!isValidYouTubeVideoId(videoId)) return null;
  try {
    const row = getFactsStmt.get(videoId) as VideoAudioFactsRow | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

export function isVideoMeasured(videoId: string): boolean {
  return getVideoAudioFacts(videoId) !== null;
}

export function getVideoLufs(videoId: string): number | null {
  const row = getVideoAudioFacts(videoId);
  if (!row || typeof row.lufs !== 'number' || !Number.isFinite(row.lufs)) {
    return null;
  }
  return row.lufs;
}

export function getAudioQcSummary(): AudioQcSummary {
  let ok = 0;
  let bad = 0;
  const badByReason: Record<string, number> = {};

  try {
    const countRows = getQcStatusCountsStmt.all() as Array<{
      status: AudioQcStatus;
      reason: string;
      cnt: number;
    }>;
    for (const row of countRows) {
      if (row.status === 'ok') {
        ok += row.cnt;
      } else if (row.status === 'bad') {
        bad += row.cnt;
        const key = row.reason || 'unknown';
        badByReason[key] = (badByReason[key] || 0) + row.cnt;
      }
    }
  } catch {
    // non-fatal
  }

  let recentRejections: TrackVideoRejectRow[] = [];
  try {
    recentRejections = getRecentRejectionsStmt.all() as TrackVideoRejectRow[];
  } catch {
    recentRejections = [];
  }

  return {
    total: ok + bad,
    ok,
    bad,
    badByReason,
    recentRejections,
  };
}

// ---------------------------------------------------------------------------
// Pure Analysis & QC Logic (exported for unit tests)
// ---------------------------------------------------------------------------

export function computeMedian(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

export function analyzeMomentaryLoudness(
  samples: MomentarySample[],
  durationSec: number
): {medianLufs: number | null; lowRunPct: number; longestRunSec: number} {
  if (!Number.isFinite(durationSec) || durationSec <= EDGE_IGNORE_SECONDS * 2 || samples.length < 2) {
    return {medianLufs: null, lowRunPct: 0, longestRunSec: 0};
  }

  const windowStart = EDGE_IGNORE_SECONDS;
  const windowEnd = durationSec - EDGE_IGNORE_SECONDS;
  const interior = samples.filter((s) => s.t >= windowStart && s.t <= windowEnd);
  if (interior.length < 2) {
    return {medianLufs: null, lowRunPct: 0, longestRunSec: 0};
  }

  // Estimate step size between consecutive ebur128 samples (~0.1s)
  const deltas: number[] = [];
  for (let i = 1; i < interior.length; i++) {
    const dt = interior[i].t - interior[i - 1].t;
    if (dt > 0 && dt < 2) deltas.push(dt);
  }
  const stepSec = computeMedian(deltas) ?? 0.1;

  const medianLufs = computeMedian(interior.map((s) => s.m));
  if (medianLufs === null || !Number.isFinite(medianLufs)) {
    return {medianLufs: null, lowRunPct: 0, longestRunSec: 0};
  }

  const threshold = medianLufs - LEVEL_DROP_DB;
  let longestRunSec = 0;
  let runStartIdx: number | null = null;

  for (let i = 0; i < interior.length; i++) {
    const isLow = interior[i].m <= threshold;
    if (isLow) {
      if (runStartIdx === null) {
        runStartIdx = i;
      }
      const runSec = interior[i].t - interior[runStartIdx].t + stepSec;
      if (runSec > longestRunSec) {
        longestRunSec = runSec;
      }
    } else {
      runStartIdx = null;
    }
  }

  const lowRunPct = Math.min(100, Math.round((longestRunSec / durationSec) * 10000) / 100);
  return {
    medianLufs: Math.round(medianLufs * 100) / 100,
    lowRunPct,
    longestRunSec: Math.round(longestRunSec * 100) / 100,
  };
}

export function evaluateAudioQc(input: {
  lufs: number | null;
  truePeakDb: number | null;
  durationSec: number;
  lowRunPct: number;
  longestRunSec: number;
  requestedDuration: number;
}): {status: AudioQcStatus; reason: AudioQcReason} {
  // 1. Almost silent audio
  const isSilentLufs =
    input.lufs === null || !Number.isFinite(input.lufs) || input.lufs <= SILENT_LUFS_THRESHOLD;
  const isSilentPeak =
    input.truePeakDb !== null &&
    Number.isFinite(input.truePeakDb) &&
    input.truePeakDb <= SILENT_TRUE_PEAK_THRESHOLD;
  if (isSilentLufs || isSilentPeak) {
    return {status: 'bad', reason: 'silent'};
  }

  // 2. Sustained quiet-section drop
  if (input.lowRunPct >= MIN_RUN_PCT && input.longestRunSec >= MIN_RUN_SECONDS) {
    return {status: 'bad', reason: 'level-drop'};
  }

  // 3. Real duration diverges from requested duration by more than max(15s, 8%)
  if (
    Number.isFinite(input.requestedDuration) &&
    input.requestedDuration > 0 &&
    Number.isFinite(input.durationSec) &&
    input.durationSec > 0
  ) {
    const allowedDiff = Math.max(15, input.requestedDuration * 0.08);
    if (Math.abs(input.durationSec - input.requestedDuration) > allowedDiff) {
      return {status: 'bad', reason: 'duration'};
    }
  }

  return {status: 'ok', reason: ''};
}

// ---------------------------------------------------------------------------
// Streaming EBU R128 Parser (single ffmpeg pass)
// ---------------------------------------------------------------------------

const FRAME_RE = /\bt:\s*(\d+(?:\.\d+)?)\s+.*?\bM:\s*(-?\d+(?:\.\d+)?|-inf)/;
const INPUT_DURATION_RE = /^\s*Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/;
const SUMMARY_HEADER_RE = /\[Parsed_ebur128[^\]]*\]\s*Summary:/;
const SUMMARY_I_RE = /^\s*I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/i;
const SUMMARY_PEAK_RE = /^\s*Peak:\s*(-?\d+(?:\.\d+)?|-inf)\s*dBFS/i;

export class Ebur128StreamParser {
  private samples: MomentarySample[] = [];
  private inputDurationSec = 0;
  private lastFrameT = 0;
  private inSummary = false;
  private summarySection: 'none' | 'integrated' | 'peak' = 'none';
  private lufs: number | null = null;
  private truePeakDb: number | null = null;
  private remainder = '';

  feed(chunk: string): void {
    const combined = this.remainder + chunk;
    const lines = combined.split(/\r?\n/);
    this.remainder = lines.pop() ?? '';
    for (const line of lines) {
      this.processLine(line);
    }
  }

  finish(): Ebur128Measurement {
    if (this.remainder) {
      this.processLine(this.remainder);
      this.remainder = '';
    }
    const durationSec =
      this.lastFrameT > 0
        ? Math.round(this.lastFrameT * 100) / 100
        : Math.round(this.inputDurationSec * 100) / 100;
    return {
      lufs: this.lufs,
      truePeakDb: this.truePeakDb,
      durationSec,
      samples: this.samples,
    };
  }

  private processLine(line: string): void {
    if (!line) return;

    if (SUMMARY_HEADER_RE.test(line)) {
      this.inSummary = true;
      this.summarySection = 'none';
      return;
    }

    if (this.inSummary) {
      if (/Integrated loudness:/i.test(line)) {
        this.summarySection = 'integrated';
        return;
      }
      if (/True peak:/i.test(line)) {
        this.summarySection = 'peak';
        return;
      }
      if (/Loudness range:/i.test(line)) {
        this.summarySection = 'none';
        return;
      }
      if (this.summarySection === 'integrated') {
        const m = SUMMARY_I_RE.exec(line);
        if (m) {
          const val = Number(m[1]);
          if (Number.isFinite(val)) this.lufs = val;
          return;
        }
      }
      if (this.summarySection === 'peak') {
        const m = SUMMARY_PEAK_RE.exec(line);
        if (m) {
          if (m[1].toLowerCase() === '-inf') {
            this.truePeakDb = -120;
          } else {
            const val = Number(m[1]);
            if (Number.isFinite(val)) this.truePeakDb = val;
          }
          return;
        }
      }
      // Any non-indented line ends the Summary block
      if (!/^\s/.test(line)) {
        this.inSummary = false;
        this.summarySection = 'none';
      }
    }

    const durMatch = INPUT_DURATION_RE.exec(line);
    if (durMatch) {
      const hh = Number(durMatch[1]);
      const mm = Number(durMatch[2]);
      const ss = Number(durMatch[3]);
      if (Number.isFinite(hh) && Number.isFinite(mm) && Number.isFinite(ss)) {
        this.inputDurationSec = hh * 3600 + mm * 60 + ss;
      }
      return;
    }

    const frameMatch = FRAME_RE.exec(line);
    if (frameMatch) {
      const t = Number(frameMatch[1]);
      const rawM = frameMatch[2];
      const m = rawM.toLowerCase() === '-inf' ? -120 : Number(rawM);
      if (Number.isFinite(t) && Number.isFinite(m)) {
        this.samples.push({t, m});
        if (t > this.lastFrameT) {
          this.lastFrameT = t;
        }
      }
    }
  }
}

export function parseEbur128Output(stderrText: string): Ebur128Measurement {
  const parser = new Ebur128StreamParser();
  parser.feed(stderrText);
  return parser.finish();
}

function resolveConfinedAudioCachePath(videoId: string): string | null {
  if (!isValidYouTubeVideoId(videoId)) return null;
  const baseDir = path.resolve(AUDIO_CACHE_DIR);
  const resolved = path.resolve(baseDir, `${videoId}.audio`);
  if (!resolved.startsWith(baseDir + path.sep)) return null;
  return resolved;
}

function runFfmpegEbur128Pass(audioPath: string): Promise<Ebur128Measurement> {
  const ffmpegPath = getFfmpegPath();
  return new Promise<Ebur128Measurement>((resolve, reject) => {
    const args = [
      '-hide_banner',
      '-nostats',
      '-threads',
      '1',
      '-i',
      audioPath,
      '-af',
      'ebur128=framelog=info:peak=true:metadata=1',
      '-f',
      'null',
      '-',
    ];

    const child = spawn(ffmpegPath, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      shell: false,
    });

    if (typeof child.pid === 'number') {
      try {
        os.setPriority(child.pid, 19);
      } catch {
        // Ignore OS priority errors on restricted environments
      }
    }

    const parser = new Ebur128StreamParser();
    let settled = false;
    const finish = (err?: Error, result?: Ebur128Measurement) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(result!);
    };

    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      finish(new Error('ffmpeg ebur128 measurement timed out'));
    }, FFMPEG_MEASURE_TIMEOUT_MS);
    timer.unref();

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      parser.feed(chunk);
    });

    child.once('error', (err) => {
      finish(err);
    });

    child.once('close', (code) => {
      if (code === 0) {
        finish(undefined, parser.finish());
      } else {
        finish(new Error(`ffmpeg ebur128 exited with code ${code}`));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Bad-Match Rejection & 2-Candidate Cap Logic
// ---------------------------------------------------------------------------

function candidateBadnessScore(
  facts: {lufs: number | null; lowRunPct: number; durationSec: number; reason: string},
  requestedDuration: number
): number {
  // Lower score = better candidate among bad ones
  let badness = 0;
  if (facts.reason === 'silent' || facts.lufs === null || facts.lufs <= SILENT_LUFS_THRESHOLD) {
    badness += 10_000;
  }
  badness += Math.max(0, facts.lowRunPct) * 10;
  if (requestedDuration > 0 && facts.durationSec > 0) {
    badness += Math.abs(facts.durationSec - requestedDuration);
  }
  return badness;
}

export function applyBadMatchRejectionPolicy(params: {
  origin: MatchedVideoOrigin;
  videoId: string;
  reason: AudioQcReason;
  facts: {lufs: number | null; lowRunPct: number; durationSec: number};
}): {rejected: boolean; keptBetterVideoId: string | null} {
  const {origin, videoId, reason, facts} = params;
  if (!reason) return {rejected: false, keptBetterVideoId: null};

  const existingRejects = (getTrackRejectsStmt.all(origin.trackKey) as TrackVideoRejectRow[]).filter(
    (r) => r.videoId !== videoId
  );

  // If this track already had 2 BAD candidates, stop rejecting and keep the better of them.
  if (existingRejects.length >= MAX_BAD_CANDIDATES_PER_TRACK) {
    const candidates: Array<{
      videoId: string;
      badness: number;
      durationSec: number;
      wasRejected: boolean;
    }> = [
      {
        videoId,
        badness: candidateBadnessScore(
          {...facts, reason},
          origin.requestedDuration
        ),
        durationSec: facts.durationSec,
        wasRejected: false,
      },
    ];

    for (const prev of existingRejects) {
      const prevFacts = getVideoAudioFacts(prev.videoId);
      if (prevFacts) {
        candidates.push({
          videoId: prev.videoId,
          badness: candidateBadnessScore(
            {
              lufs: prevFacts.lufs,
              lowRunPct: prevFacts.lowRunPct,
              durationSec: prevFacts.durationSec,
              reason: prevFacts.reason || prev.reason,
            },
            origin.requestedDuration
          ),
          durationSec: prevFacts.durationSec,
          wasRejected: true,
        });
      }
    }

    candidates.sort((a, b) => a.badness - b.badness);
    const winner = candidates[0];

    if (winner.wasRejected) {
      // Restore the better previously-rejected candidate and stop rejecting further
      try {
        deleteTrackRejectStmt.run(origin.trackKey, winner.videoId);
      } catch {
        // non-fatal
      }
      upsertTrackVideoMapEntry({
        matchKey: origin.trackKey,
        artist: origin.artist,
        title: origin.title,
        duration: origin.requestedDuration,
        videoId: winner.videoId,
        matchedTitle: origin.title,
        matchedDuration: Math.round(winner.durationSec),
      });
    } else {
      // Keep the current candidate in track_video_map (do NOT reject it)
      upsertTrackVideoMapEntry({
        matchKey: origin.trackKey,
        artist: origin.artist,
        title: origin.title,
        duration: origin.requestedDuration,
        videoId,
        matchedTitle: origin.title,
        matchedDuration: Math.round(facts.durationSec),
      });
    }

    return {rejected: false, keptBetterVideoId: winner.videoId};
  }

  // Fewer than 2 BAD candidates so far: delete map entry, record global reject, and log
  deleteTrackVideoMapEntry(origin.trackKey);
  try {
    insertTrackRejectStmt.run(origin.trackKey, videoId, reason, Date.now());
  } catch {
    // non-fatal
  }

  console.warn(
    `[audio-qc] bad ${videoId} ${reason} for ${origin.artist} - ${origin.title}; next best will be used`
  );

  return {rejected: true, keptBetterVideoId: null};
}

// ---------------------------------------------------------------------------
// Single-Concurrency Low-Priority Background Queue
// ---------------------------------------------------------------------------

const pendingQueue: string[] = [];
const pendingSet = new Set<string>();
let workerActive = false;
let busyRetryTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleRetryWhenIdle(): void {
  if (busyRetryTimer) return;
  busyRetryTimer = setTimeout(() => {
    busyRetryTimer = null;
    pumpQueue();
  }, BUSY_RETRY_DELAY_MS);
  busyRetryTimer.unref();
}

async function measureAndStoreVideo(videoId: string): Promise<void> {
  if (isVideoMeasured(videoId)) return;

  const audioPath = resolveConfinedAudioCachePath(videoId);
  if (!audioPath) return;

  try {
    const stat = fs.statSync(audioPath);
    if (!stat.isFile() || stat.size <= 0) return;
  } catch {
    return;
  }

  const measurement = await runFfmpegEbur128Pass(audioPath);
  const {lowRunPct, longestRunSec} = analyzeMomentaryLoudness(
    measurement.samples,
    measurement.durationSec
  );

  // Only videos chosen by artist+title matching are subject to BAD auto-rejection;
  // videos opened by explicit videoId have no matched origins and always store status='ok'.
  const origins = getMatchedVideoOrigins(videoId);
  let overallStatus: AudioQcStatus = 'ok';
  let overallReason: AudioQcReason = '';

  for (const origin of origins) {
    const qc = evaluateAudioQc({
      lufs: measurement.lufs,
      truePeakDb: measurement.truePeakDb,
      durationSec: measurement.durationSec,
      lowRunPct,
      longestRunSec,
      requestedDuration: origin.requestedDuration,
    });

    if (qc.status === 'bad' && qc.reason) {
      if (overallStatus !== 'bad') {
        overallStatus = 'bad';
        overallReason = qc.reason;
      }
      applyBadMatchRejectionPolicy({
        origin,
        videoId,
        reason: qc.reason,
        facts: {
          lufs: measurement.lufs,
          lowRunPct,
          durationSec: measurement.durationSec,
        },
      });
    }
  }

  try {
    insertFactsStmt.run(
      videoId,
      measurement.lufs !== null && Number.isFinite(measurement.lufs)
        ? Math.round(measurement.lufs * 100) / 100
        : null,
      measurement.truePeakDb !== null && Number.isFinite(measurement.truePeakDb)
        ? Math.round(measurement.truePeakDb * 100) / 100
        : null,
      measurement.durationSec,
      lowRunPct,
      overallStatus,
      overallReason,
      Date.now()
    );
  } catch {
    // non-fatal
  }
}

function pumpQueue(): void {
  if (workerActive || pendingQueue.length === 0) return;

  // Skip while the resolver queue is busy; retry once idle so we never delay playback/fills/prefetch
  if (isResolverQueueBusy()) {
    scheduleRetryWhenIdle();
    return;
  }

  const videoId = pendingQueue.shift();
  if (!videoId) return;
  pendingSet.delete(videoId);

  if (isVideoMeasured(videoId)) {
    setImmediate(pumpQueue);
    return;
  }

  workerActive = true;
  void (async () => {
    try {
      await measureAndStoreVideo(videoId);
    } catch {
      // Strictly best-effort background job; never disrupt server
    } finally {
      workerActive = false;
      if (pendingQueue.length > 0) {
        if (isResolverQueueBusy()) {
          scheduleRetryWhenIdle();
        } else {
          setImmediate(pumpQueue);
        }
      }
    }
  })();
}

/**
 * Queue a non-blocking background EBU R128 loudness & QC measurement for a cached videoId.
 * Runs strictly one at a time at low priority, skips while the resolver queue is busy,
 * and never measures the same videoId twice.
 */
export function enqueueAudioFactsMeasurement(videoId: string): void {
  if (!isValidYouTubeVideoId(videoId)) return;
  if (pendingSet.has(videoId)) return;
  if (pendingQueue.length >= MAX_PENDING_JOBS) return;
  if (isVideoMeasured(videoId)) return;

  pendingSet.add(videoId);
  pendingQueue.push(videoId);
  setImmediate(pumpQueue);
}
