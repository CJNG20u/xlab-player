import {apiFetch, getCoverUrl, getStoredToken, getStreamUrl} from '../lib/api';
import type {Playlist, Track} from '../types';

export const OFFLINE_AUDIO_CACHE_NAME = 'xlabplayer-audio-v1';
const OFFLINE_DB_NAME = 'xlabplayer-offline-db';
const OFFLINE_DB_VERSION = 1;

const STORE_TRACKS = 'tracks';
const STORE_COVERS = 'covers';
const STORE_PLAYLISTS = 'playlists';

export interface OfflineTrackRecord extends Track {
  cachedAt: string;
  cachedBytes: number;
  audioMimeType: string;
  lyrics?: string | null;
}

export interface OfflineCoverRecord {
  coverFile: string;
  blob: Blob;
  mimeType: string;
  sizeBytes: number;
  cachedAt: string;
}

export interface OfflinePlaylistRecord extends Playlist {
  trackIds: number[];
  cachedAt: string;
}

export interface OfflineStorageUsage {
  totalBytes: number;
  totalMB: number;
  audioBytes: number;
  coverBytes: number;
  trackCount: number;
  playlistCount: number;
  quotaBytes: number | null;
  browserUsageBytes: number | null;
}

const listeners = new Set<() => void>();
const coverBlobUrlMemo = new Map<string, string>();
let dbPromise: Promise<IDBDatabase> | null = null;

function notifyOfflineStoreChanged(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // ignore subscriber errors
    }
  }
}

export function subscribeOfflineStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function isOfflineCachingSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'caches' in window &&
    'indexedDB' in window
  );
}

function getAudioCacheKey(trackId: number): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://localhost';
  return `${origin}/offline-audio/${trackId}`;
}

function inferAudioMimeType(format?: string, contentType?: string | null): string {
  const cleanHeader = (contentType || '').split(';')[0].trim().toLowerCase();
  if (cleanHeader && cleanHeader.startsWith('audio/')) {
    return cleanHeader;
  }
  switch ((format || '').toLowerCase()) {
    case 'm4a':
    case 'mp4':
      return 'audio/mp4';
    case 'mp3':
      return 'audio/mpeg';
    case 'opus':
      return 'audio/ogg; codecs=opus';
    case 'ogg':
      return 'audio/ogg';
    case 'flac':
      return 'audio/flac';
    case 'wav':
      return 'audio/wav';
    default:
      return 'audio/mpeg';
  }
}

function openOfflineDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB is unavailable in this browser context.'));
  }
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_TRACKS)) {
        db.createObjectStore(STORE_TRACKS, {keyPath: 'id'});
      }
      if (!db.objectStoreNames.contains(STORE_COVERS)) {
        db.createObjectStore(STORE_COVERS, {keyPath: 'coverFile'});
      }
      if (!db.objectStoreNames.contains(STORE_PLAYLISTS)) {
        db.createObjectStore(STORE_PLAYLISTS, {keyPath: 'id'});
      }
    };

    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };

    req.onerror = () => {
      dbPromise = null;
      reject(req.error || new Error('Failed to open offline IndexedDB'));
    };
  });

  return dbPromise;
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

function idbTxComplete(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });
}

async function cacheCoverArtBlob(coverFile: string | null | undefined): Promise<number> {
  if (!coverFile) return 0;
  try {
    const db = await openOfflineDb();
    const existingTx = db.transaction(STORE_COVERS, 'readonly');
    const existing = (await idbRequest(
      existingTx.objectStore(STORE_COVERS).get(coverFile)
    )) as OfflineCoverRecord | undefined;
    if (existing && existing.blob && existing.blob.size > 0) {
      return existing.sizeBytes || existing.blob.size;
    }

    const coverUrl = getCoverUrl(coverFile);
    if (!coverUrl) return 0;

    const res = await fetch(coverUrl, {credentials: 'include'});
    if (!res.ok) return 0;
    const blob = await res.blob();
    if (!blob || blob.size === 0) return 0;

    const record: OfflineCoverRecord = {
      coverFile,
      blob,
      mimeType: blob.type || 'image/jpeg',
      sizeBytes: blob.size,
      cachedAt: new Date().toISOString(),
    };
    const writeTx = db.transaction(STORE_COVERS, 'readwrite');
    writeTx.objectStore(STORE_COVERS).put(record);
    await idbTxComplete(writeTx);
    return blob.size;
  } catch {
    return 0;
  }
}

async function fetchLyricsBestEffort(trackId: number): Promise<string | null> {
  try {
    const res = await apiFetch<{lyrics: string | null}>(`/api/tracks/${trackId}/lyrics`);
    return res.lyrics ?? null;
  } catch {
    return null;
  }
}

export async function saveOfflinePlaylistMetadata(
  playlist: Playlist,
  trackIds: number[]
): Promise<void> {
  if (!('indexedDB' in window)) return;
  const db = await openOfflineDb();
  const record: OfflinePlaylistRecord = {
    ...playlist,
    trackIds: [...trackIds],
    cachedAt: new Date().toISOString(),
  };
  const tx = db.transaction(STORE_PLAYLISTS, 'readwrite');
  tx.objectStore(STORE_PLAYLISTS).put(record);
  await idbTxComplete(tx);
  notifyOfflineStoreChanged();
}

export async function downloadTrackOffline(
  track: Track,
  options?: {
    playlist?: Playlist;
    playlistTrackIds?: number[];
    onProgress?: (percent: number) => void;
    signal?: AbortSignal;
  }
): Promise<OfflineTrackRecord> {
  if (!isOfflineCachingSupported()) {
    throw new Error(
      'Offline caching requires HTTPS or localhost (Cache Storage and IndexedDB must be available).'
    );
  }

  const streamUrl = getStreamUrl(track.id);
  const headers = new Headers();
  const token = getStoredToken();
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const response = await fetch(streamUrl, {
    method: 'GET',
    headers,
    credentials: 'include',
    signal: options?.signal,
  });

  if (!response.ok) {
    throw new Error(`Failed to download audio (HTTP ${response.status})`);
  }

  const audioMimeType = inferAudioMimeType(track.format, response.headers.get('Content-Type'));
  const totalHeader = Number(response.headers.get('Content-Length') || track.size_bytes || 0);

  let audioBlob: Blob;
  if (response.body && typeof response.body.getReader === 'function' && options?.onProgress) {
    const reader = response.body.getReader();
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let received = 0;
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      if (value) {
        const copy = new Uint8Array(value.byteLength);
        copy.set(value);
        chunks.push(copy);
        received += value.byteLength;
        if (totalHeader > 0) {
          options.onProgress(Math.min(99, Math.round((received / totalHeader) * 100)));
        }
      }
    }
    audioBlob = new Blob(chunks, {type: audioMimeType});
  } else {
    const rawBlob = await response.blob();
    audioBlob = rawBlob.type === audioMimeType ? rawBlob : new Blob([rawBlob], {type: audioMimeType});
  }

  if (audioBlob.size === 0) {
    throw new Error('Downloaded audio file was empty');
  }

  // Store full audio response in Cache Storage (`xlabplayer-audio-v1`)
  const cache = await caches.open(OFFLINE_AUDIO_CACHE_NAME);
  const cacheResponse = new Response(audioBlob, {
    status: 200,
    statusText: 'OK',
    headers: {
      'Content-Type': audioMimeType,
      'Content-Length': String(audioBlob.size),
      'X-Xlab-Track-Id': String(track.id),
    },
  });
  await cache.put(getAudioCacheKey(track.id), cacheResponse);

  // Cache cover art blob & lyrics in IndexedDB in parallel
  const [, lyrics] = await Promise.all([
    cacheCoverArtBlob(track.cover_file),
    fetchLyricsBestEffort(track.id),
  ]);

  const record: OfflineTrackRecord = {
    ...track,
    cachedAt: new Date().toISOString(),
    cachedBytes: audioBlob.size,
    audioMimeType,
    lyrics,
  };

  const db = await openOfflineDb();
  const tx = db.transaction(
    options?.playlist ? [STORE_TRACKS, STORE_PLAYLISTS] : [STORE_TRACKS],
    'readwrite'
  );
  tx.objectStore(STORE_TRACKS).put(record);
  if (options?.playlist) {
    const plRecord: OfflinePlaylistRecord = {
      ...options.playlist,
      trackIds: options.playlistTrackIds || [],
      cachedAt: new Date().toISOString(),
    };
    tx.objectStore(STORE_PLAYLISTS).put(plRecord);
  }
  await idbTxComplete(tx);

  options?.onProgress?.(100);
  notifyOfflineStoreChanged();
  return record;
}

export async function removeOfflineTrack(trackId: number): Promise<void> {
  if (!isOfflineCachingSupported()) return;

  try {
    const cache = await caches.open(OFFLINE_AUDIO_CACHE_NAME);
    await cache.delete(getAudioCacheKey(trackId));
  } catch {
    // ignore cache deletion failure
  }

  const db = await openOfflineDb();

  // Read target track & remaining tracks so we can clean orphaned covers & playlists
  const readTx = db.transaction([STORE_TRACKS, STORE_PLAYLISTS], 'readonly');
  const targetTrack = (await idbRequest(
    readTx.objectStore(STORE_TRACKS).get(trackId)
  )) as OfflineTrackRecord | undefined;
  const allTracks = (await idbRequest(
    readTx.objectStore(STORE_TRACKS).getAll()
  )) as OfflineTrackRecord[];
  const allPlaylists = (await idbRequest(
    readTx.objectStore(STORE_PLAYLISTS).getAll()
  )) as OfflinePlaylistRecord[];

  const remainingTracks = allTracks.filter((t) => t.id !== trackId);
  const remainingTrackIds = new Set(remainingTracks.map((t) => t.id));
  const coverStillReferenced = Boolean(
    targetTrack?.cover_file &&
      remainingTracks.some((t) => t.cover_file === targetTrack.cover_file)
  );

  const writeTx = db.transaction([STORE_TRACKS, STORE_COVERS, STORE_PLAYLISTS], 'readwrite');
  writeTx.objectStore(STORE_TRACKS).delete(trackId);

  if (targetTrack?.cover_file && !coverStillReferenced) {
    writeTx.objectStore(STORE_COVERS).delete(targetTrack.cover_file);
    const memoUrl = coverBlobUrlMemo.get(targetTrack.cover_file);
    if (memoUrl) {
      URL.revokeObjectURL(memoUrl);
      coverBlobUrlMemo.delete(targetTrack.cover_file);
    }
  }

  for (const pl of allPlaylists) {
    const hasAnyCached = pl.trackIds.some((id) => remainingTrackIds.has(id));
    if (!hasAnyCached) {
      writeTx.objectStore(STORE_PLAYLISTS).delete(pl.id);
    }
  }

  await idbTxComplete(writeTx);
  notifyOfflineStoreChanged();
}

export async function isTrackCached(trackId: number): Promise<boolean> {
  if (!isOfflineCachingSupported()) return false;
  try {
    const cache = await caches.open(OFFLINE_AUDIO_CACHE_NAME);
    const match = await cache.match(getAudioCacheKey(trackId));
    return Boolean(match);
  } catch {
    return false;
  }
}

export async function getCachedTrackIds(): Promise<Set<number>> {
  if (!isOfflineCachingSupported()) return new Set();
  try {
    const db = await openOfflineDb();
    const tx = db.transaction(STORE_TRACKS, 'readonly');
    const keys = (await idbRequest(tx.objectStore(STORE_TRACKS).getAllKeys())) as Array<
      number | string
    >;
    return new Set(keys.map((k) => Number(k)).filter((n) => Number.isFinite(n)));
  } catch {
    return new Set();
  }
}

export async function getOfflineTracks(): Promise<OfflineTrackRecord[]> {
  if (!isOfflineCachingSupported()) return [];
  try {
    const db = await openOfflineDb();
    const tx = db.transaction(STORE_TRACKS, 'readonly');
    const records = (await idbRequest(
      tx.objectStore(STORE_TRACKS).getAll()
    )) as OfflineTrackRecord[];
    return records.sort((a, b) => (b.cachedAt || '').localeCompare(a.cachedAt || ''));
  } catch {
    return [];
  }
}

export async function getOfflinePlaylists(): Promise<OfflinePlaylistRecord[]> {
  if (!isOfflineCachingSupported()) return [];
  try {
    const db = await openOfflineDb();
    const tx = db.transaction([STORE_PLAYLISTS, STORE_TRACKS], 'readonly');
    const [playlists, trackKeys] = await Promise.all([
      idbRequest(tx.objectStore(STORE_PLAYLISTS).getAll()) as Promise<OfflinePlaylistRecord[]>,
      idbRequest(tx.objectStore(STORE_TRACKS).getAllKeys()) as Promise<Array<number | string>>,
    ]);
    const cachedIds = new Set(trackKeys.map((k) => Number(k)));
    return playlists
      .map((pl) => {
        const availableIds = (pl.trackIds || []).filter((id) => cachedIds.has(id));
        return {
          ...pl,
          trackIds: availableIds,
          track_count: availableIds.length,
        };
      })
      .filter((pl) => pl.trackIds.length > 0)
      .sort((a, b) => (b.cachedAt || '').localeCompare(a.cachedAt || ''));
  } catch {
    return [];
  }
}

export async function getOfflinePlaylistTracks(
  playlistId: number
): Promise<{playlist: OfflinePlaylistRecord; tracks: OfflineTrackRecord[]} | null> {
  if (!isOfflineCachingSupported()) return null;
  try {
    const db = await openOfflineDb();
    const tx = db.transaction([STORE_PLAYLISTS, STORE_TRACKS], 'readonly');
    const [playlist, allTracks] = await Promise.all([
      idbRequest(tx.objectStore(STORE_PLAYLISTS).get(playlistId)) as Promise<
        OfflinePlaylistRecord | undefined
      >,
      idbRequest(tx.objectStore(STORE_TRACKS).getAll()) as Promise<OfflineTrackRecord[]>,
    ]);
    if (!playlist) return null;

    const byId = new Map(allTracks.map((t) => [t.id, t]));
    const orderedTracks: OfflineTrackRecord[] = [];
    for (const id of playlist.trackIds || []) {
      const found = byId.get(id);
      if (found) orderedTracks.push(found);
    }

    return {
      playlist: {
        ...playlist,
        track_count: orderedTracks.length,
      },
      tracks: orderedTracks,
    };
  } catch {
    return null;
  }
}

export async function getOfflineAudioBlob(trackId: number): Promise<Blob | null> {
  if (!isOfflineCachingSupported()) return null;
  try {
    const cache = await caches.open(OFFLINE_AUDIO_CACHE_NAME);
    const match = await cache.match(getAudioCacheKey(trackId));
    if (!match) return null;
    const blob = await match.blob();
    if (!blob || blob.size === 0) return null;
    if (blob.type) return blob;
    const headerType = match.headers.get('Content-Type') || 'audio/mpeg';
    return new Blob([blob], {type: headerType});
  } catch {
    return null;
  }
}

export async function getOfflineCoverBlobUrl(
  coverFile: string | null | undefined
): Promise<string | null> {
  if (!coverFile || !('indexedDB' in window)) return null;
  const cached = coverBlobUrlMemo.get(coverFile);
  if (cached) return cached;

  try {
    const db = await openOfflineDb();
    const tx = db.transaction(STORE_COVERS, 'readonly');
    const record = (await idbRequest(
      tx.objectStore(STORE_COVERS).get(coverFile)
    )) as OfflineCoverRecord | undefined;
    if (!record || !record.blob || record.blob.size === 0) return null;
    const url = URL.createObjectURL(record.blob);
    coverBlobUrlMemo.set(coverFile, url);
    return url;
  } catch {
    return null;
  }
}

export async function getOfflineTrackLyrics(trackId: number): Promise<string | null> {
  if (!('indexedDB' in window)) return null;
  try {
    const db = await openOfflineDb();
    const tx = db.transaction(STORE_TRACKS, 'readonly');
    const record = (await idbRequest(
      tx.objectStore(STORE_TRACKS).get(trackId)
    )) as OfflineTrackRecord | undefined;
    return record?.lyrics ?? null;
  } catch {
    return null;
  }
}

export async function getOfflineStorageUsage(): Promise<OfflineStorageUsage> {
  if (!isOfflineCachingSupported()) {
    return {
      totalBytes: 0,
      totalMB: 0,
      audioBytes: 0,
      coverBytes: 0,
      trackCount: 0,
      playlistCount: 0,
      quotaBytes: null,
      browserUsageBytes: null,
    };
  }

  let audioBytes = 0;
  let coverBytes = 0;
  let trackCount = 0;
  let playlistCount = 0;

  try {
    const db = await openOfflineDb();
    const tx = db.transaction([STORE_TRACKS, STORE_COVERS, STORE_PLAYLISTS], 'readonly');
    const [tracks, covers, playlists] = await Promise.all([
      idbRequest(tx.objectStore(STORE_TRACKS).getAll()) as Promise<OfflineTrackRecord[]>,
      idbRequest(tx.objectStore(STORE_COVERS).getAll()) as Promise<OfflineCoverRecord[]>,
      idbRequest(tx.objectStore(STORE_PLAYLISTS).getAll()) as Promise<OfflinePlaylistRecord[]>,
    ]);

    trackCount = tracks.length;
    audioBytes = tracks.reduce((sum, t) => sum + (t.cachedBytes || t.size_bytes || 0), 0);
    coverBytes = covers.reduce((sum, c) => sum + (c.sizeBytes || c.blob?.size || 0), 0);

    const trackIdSet = new Set(tracks.map((t) => t.id));
    playlistCount = playlists.filter((p) =>
      (p.trackIds || []).some((id) => trackIdSet.has(id))
    ).length;
  } catch {
    // ignore
  }

  let quotaBytes: number | null = null;
  let browserUsageBytes: number | null = null;
  if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
    try {
      const est = await navigator.storage.estimate();
      if (typeof est.quota === 'number') quotaBytes = est.quota;
      if (typeof est.usage === 'number') browserUsageBytes = est.usage;
    } catch {
      // ignore
    }
  }

  const totalBytes = audioBytes + coverBytes;
  const totalMB = Math.round((totalBytes / (1024 * 1024)) * 100) / 100;

  return {
    totalBytes,
    totalMB,
    audioBytes,
    coverBytes,
    trackCount,
    playlistCount,
    quotaBytes,
    browserUsageBytes,
  };
}

export async function clearAllOfflineMusic(): Promise<void> {
  if (!isOfflineCachingSupported()) return;

  try {
    await caches.delete(OFFLINE_AUDIO_CACHE_NAME);
  } catch {
    // ignore
  }

  for (const url of coverBlobUrlMemo.values()) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // ignore
    }
  }
  coverBlobUrlMemo.clear();

  try {
    const db = await openOfflineDb();
    const tx = db.transaction([STORE_TRACKS, STORE_COVERS, STORE_PLAYLISTS], 'readwrite');
    tx.objectStore(STORE_TRACKS).clear();
    tx.objectStore(STORE_COVERS).clear();
    tx.objectStore(STORE_PLAYLISTS).clear();
    await idbTxComplete(tx);
  } catch {
    // ignore
  }

  notifyOfflineStoreChanged();
}
