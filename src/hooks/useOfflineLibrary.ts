import {useCallback, useEffect, useState} from 'react';
import type {Playlist, Track} from '../types';
import {
  downloadTrackOffline,
  getCachedTrackIds,
  isOfflineCachingSupported,
  removeOfflineTrack,
  subscribeOfflineStore,
} from '../utils/offlineStore';

// Module-level shared active-download tracker so TrackTable, playlist headers,
// and library views stay synchronized and prevent duplicate downloads.
const activeDownloads = new Set<number>();
const downloadListeners = new Set<() => void>();

function notifyDownloadState(): void {
  for (const listener of downloadListeners) {
    try {
      listener();
    } catch {
      // ignore
    }
  }
}

export function useOfflineLibrary() {
  const supported = isOfflineCachingSupported();
  const [cachedTrackIds, setCachedTrackIds] = useState<Set<number>>(() => new Set());
  const [downloadingTrackIds, setDownloadingTrackIds] = useState<Set<number>>(
    () => new Set(activeDownloads)
  );

  const refreshCachedIds = useCallback(async () => {
    if (!supported) return;
    const ids = await getCachedTrackIds();
    setCachedTrackIds(ids);
  }, [supported]);

  useEffect(() => {
    void refreshCachedIds();
    const unsubStore = subscribeOfflineStore(() => {
      void refreshCachedIds();
    });
    const onDownloadChange = () => {
      setDownloadingTrackIds(new Set(activeDownloads));
    };
    downloadListeners.add(onDownloadChange);
    return () => {
      unsubStore();
      downloadListeners.delete(onDownloadChange);
    };
  }, [refreshCachedIds]);

  const downloadTrack = useCallback(
    async (
      track: Track,
      options?: {
        playlist?: Playlist;
        playlistTrackIds?: number[];
        onProgress?: (percent: number) => void;
        signal?: AbortSignal;
      }
    ): Promise<boolean> => {
      if (typeof track.id !== 'number') return false;
      const trackId = track.id;
      if (activeDownloads.has(trackId)) return false;
      activeDownloads.add(trackId);
      notifyDownloadState();
      try {
        await downloadTrackOffline(track, options);
        return true;
      } finally {
        activeDownloads.delete(trackId);
        notifyDownloadState();
      }
    },
    []
  );

  const removeTrack = useCallback(async (trackId: number): Promise<void> => {
    await removeOfflineTrack(trackId);
  }, []);

  return {
    supported,
    cachedTrackIds,
    downloadingTrackIds,
    downloadTrack,
    removeTrack,
    refreshCachedIds,
  };
}
