import {useEffect, useRef, useSyncExternalStore} from 'react';
import type {YouTubePlaylistJob, YouTubePlaylistJobState} from '../types';
import {apiFetch} from './api';

type Listener = () => void;

const listeners = new Set<Listener>();
let jobsSnapshot: YouTubePlaylistJob[] = [];
let inFlightRefresh: Promise<YouTubePlaylistJob[]> | null = null;

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): YouTubePlaylistJob[] {
  return jobsSnapshot;
}

function setJobs(next: YouTubePlaylistJob[]): void {
  jobsSnapshot = next;
  notify();
}

export function clearYouTubePlaylistJobs(): void {
  if (jobsSnapshot.length === 0) return;
  setJobs([]);
}

export function upsertYouTubePlaylistJob(job: YouTubePlaylistJob): void {
  const existingIdx = jobsSnapshot.findIndex((j) => j.id === job.id);
  if (existingIdx >= 0) {
    const next = jobsSnapshot.slice();
    // Preserve detailed items if the incoming summary omits them
    next[existingIdx] = {
      ...next[existingIdx],
      ...job,
      items: job.items ?? next[existingIdx].items,
    };
    setJobs(next);
  } else {
    setJobs([job, ...jobsSnapshot]);
  }
}

export async function refreshYouTubePlaylistJobs(): Promise<YouTubePlaylistJob[]> {
  if (inFlightRefresh) return inFlightRefresh;
  inFlightRefresh = (async () => {
    try {
      const res = await apiFetch<{jobs: YouTubePlaylistJob[]}>('/api/youtube/playlist-jobs');
      const incoming = Array.isArray(res.jobs) ? res.jobs : [];
      const prevById = new Map(jobsSnapshot.map((j) => [j.id, j]));
      const merged = incoming.map((job) => {
        const prev = prevById.get(job.id);
        return prev?.items && !job.items ? {...job, items: prev.items} : job;
      });
      setJobs(merged);
      return merged;
    } catch {
      return jobsSnapshot;
    } finally {
      inFlightRefresh = null;
    }
  })();
  return inFlightRefresh;
}

export async function fetchYouTubePlaylistJobDetail(
  jobId: string
): Promise<YouTubePlaylistJob | null> {
  try {
    const job = await apiFetch<YouTubePlaylistJob>(
      `/api/youtube/playlist-jobs/${encodeURIComponent(jobId)}`
    );
    if (job && job.id) {
      upsertYouTubePlaylistJob(job);
      return job;
    }
    return null;
  } catch {
    return null;
  }
}

export async function cancelYouTubePlaylistJob(jobId: string): Promise<YouTubePlaylistJob | null> {
  const job = await apiFetch<YouTubePlaylistJob>(
    `/api/youtube/playlist-jobs/${encodeURIComponent(jobId)}/cancel`,
    {method: 'POST'}
  );
  if (job && job.id) {
    upsertYouTubePlaylistJob(job);
    return job;
  }
  return null;
}

export function useYouTubePlaylistJobs(): YouTubePlaylistJob[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

interface UseYouTubePlaylistJobsSyncCallbacks {
  onProgress?: () => void;
  onComplete?: (job: YouTubePlaylistJob) => void;
}

const POLL_INTERVAL_MS = 2500;

export function useYouTubePlaylistJobsSync(
  enabled: boolean,
  callbacks: UseYouTubePlaylistJobsSyncCallbacks
): void {
  const jobs = useYouTubePlaylistJobs();
  const hasRunningJob = jobs.some((j) => j.state === 'running');
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  const prevStateRef = useRef<Map<string, {state: YouTubePlaylistJobState; done: number}>>(
    new Map()
  );
  const initializedRef = useRef(false);

  // Detect progress increments & running -> completed/failed transitions
  useEffect(() => {
    if (!enabled) {
      prevStateRef.current.clear();
      initializedRef.current = false;
      return;
    }

    const prevMap = prevStateRef.current;
    let sawProgress = false;
    const newlyFinished: YouTubePlaylistJob[] = [];

    if (initializedRef.current) {
      for (const job of jobs) {
        const prev = prevMap.get(job.id);
        if (!prev) continue;
        if (job.done > prev.done) {
          sawProgress = true;
        }
        if (prev.state === 'running' && (job.state === 'completed' || job.state === 'failed')) {
          newlyFinished.push(job);
        }
      }
    }

    const nextMap = new Map<string, {state: YouTubePlaylistJobState; done: number}>();
    for (const job of jobs) {
      nextMap.set(job.id, {state: job.state, done: job.done});
    }
    prevStateRef.current = nextMap;
    initializedRef.current = true;

    if (sawProgress) {
      callbacksRef.current.onProgress?.();
    }
    for (const finishedJob of newlyFinished) {
      callbacksRef.current.onComplete?.(finishedJob);
    }
  }, [enabled, jobs]);

  // Restore server-side jobs immediately on mount/login/reconnect and on visibility return
  useEffect(() => {
    if (!enabled) {
      clearYouTubePlaylistJobs();
      return;
    }

    void refreshYouTubePlaylistJobs();

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void refreshYouTubePlaylistJobs();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [enabled]);

  // Poll every 2.5s while any playlist download job is running
  useEffect(() => {
    if (!enabled || !hasRunningJob) return;

    const intervalId = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      void refreshYouTubePlaylistJobs();
    }, POLL_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [enabled, hasRunningJob]);
}
