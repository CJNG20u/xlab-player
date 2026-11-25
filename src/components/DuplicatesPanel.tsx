import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Copy,
  Disc3,
  Heart,
  Loader2,
  RefreshCw,
  Sparkles,
  Trash2,
  Volume2,
  X,
} from 'lucide-react';
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {usePlayer} from '../context/PlayerContext';
import {useLayoutMode} from '../hooks/useLayoutMode';
import {apiFetch, formatDuration, getStoredToken} from '../lib/api';
import type {Track} from '../types';
import {AlbumArt} from './AlbumArt';

export interface DuplicateCopyItem {
  id: number;
  title: string;
  artist: string;
  album: string;
  duration: number;
  source: 'local' | 'youtube' | 'catalog';
  sourceLabel: string;
  format: string;
  bitrate: number;
  qualityLabel: string;
  cover_file: string | null;
  dominant_color: string;
  added_at: string;
  playlistCount: number;
  liked: boolean;
  isPlaying: boolean;
  suggestedKeep: boolean;
}

export interface DuplicateGroupItem {
  id: string;
  matchType: 'definite' | 'likely';
  label: 'Same song' | 'Probably the same';
  suggestedKeepId: number;
  copies: DuplicateCopyItem[];
  safeForBulk: boolean;
  bulkSkipReason: string | null;
  bulkRemovableCount: number;
}

interface DuplicatesListResponse {
  groups: DuplicateGroupItem[];
  totalGroups: number;
}

interface ResolveDuplicateResponse {
  ok: boolean;
  keepId: number;
  removeId: number;
  playlistsUpdated: number;
  keepLiked: boolean;
  keepTrack: Track;
  remainingGroup: DuplicateGroupItem | null;
}

export interface BulkResolvedReplacementItem {
  removeId: number;
  keepId: number;
  keepLiked: boolean;
  playlistsUpdated: number;
  keepTrack: Track;
}

interface BulkSkippedGroupItem {
  groupId: string;
  title: string;
  artist: string;
  copyCount: number;
  reason: string;
}

interface BulkFailedGroupItem {
  groupId: string;
  title: string;
  artist: string;
  copyCount: number;
  reason: string;
}

interface BulkResolveSummaryResponse {
  totalPlanned: number;
  removedCount: number;
  resolvedGroupCount: number;
  skippedCount: number;
  failedCount: number;
  replacements: BulkResolvedReplacementItem[];
  skipped: BulkSkippedGroupItem[];
  failed: BulkFailedGroupItem[];
}

type BulkStreamEvent =
  | {
      type: 'start';
      totalPlanned: number;
      safeGroupCount: number;
      skippedGroupCount: number;
    }
  | {
      type: 'progress';
      removedCount: number;
      totalPlanned: number;
      groupId: string;
      status: 'resolved' | 'failed';
      replacements?: BulkResolvedReplacementItem[];
      error?: string;
    }
  | {
      type: 'done';
      summary: BulkResolveSummaryResponse;
    }
  | {
      type: 'error';
      error: string;
    };

interface ConfirmRemoveTarget {
  group: DuplicateGroupItem;
  removeCopy: DuplicateCopyItem;
  keepCopy: DuplicateCopyItem;
}

interface ConfirmBulkSnapshot {
  removableCopies: number;
  safeGroups: number;
  skippedGroups: number;
}

interface DuplicatesPanelProps {
  open: boolean;
  onClose: () => void;
  onDuplicateRemoved?: (payload: {
    removeId: number;
    keepTrack: Track;
    keepLiked: boolean;
    playlistsUpdated: number;
  }) => void;
  onBulkDuplicatesRemoved?: (replacements: BulkResolvedReplacementItem[]) => void;
}

export const DuplicatesPanel: React.FC<DuplicatesPanelProps> = ({
  open,
  onClose,
  onDuplicateRemoved,
  onBulkDuplicatesRemoved,
}) => {
  const layoutMode = useLayoutMode();
  const isDesktop = layoutMode === 'desktop';
  const {
    currentTrack,
    isPlaying,
    replaceDuplicateInQueue,
    syncTrackLikeState,
    bumpLibraryRefresh,
  } = usePlayer();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [groups, setGroups] = useState<DuplicateGroupItem[]>([]);
  const [confirmTarget, setConfirmTarget] = useState<ConfirmRemoveTarget | null>(null);
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);

  // Bulk resolve state
  const [confirmBulk, setConfirmBulk] = useState<ConfirmBulkSnapshot | null>(null);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<{removed: number; total: number} | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkSummary, setBulkSummary] = useState<BulkResolveSummaryResponse | null>(null);

  const activeNumericTrackId =
    isPlaying && currentTrack && typeof currentTrack.id === 'number' ? currentTrack.id : null;
  const activePlayingIdRef = React.useRef<number | null>(activeNumericTrackId);
  activePlayingIdRef.current = activeNumericTrackId;

  const fetchDuplicates = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const playingId = activePlayingIdRef.current;
      const qs = playingId ? `?playingTrackId=${playingId}` : '';
      const data = await apiFetch<DuplicatesListResponse>(`/api/library/duplicates${qs}`);
      setGroups(Array.isArray(data.groups) ? data.groups : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to scan library for duplicates');
    } finally {
      setLoading(false);
    }
  }, []);

  // Compute duplicates ONLY when the panel is opened (never on Home mount)
  useEffect(() => {
    if (!open) {
      setConfirmTarget(null);
      setConfirmBulk(null);
      setResolveError(null);
      setBulkError(null);
      setStatusNotice(null);
      setBulkSummary(null);
      return;
    }
    void fetchDuplicates();
  }, [open, fetchDuplicates]);

  // Close on Escape (confirmation dialogs first, then panel)
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (confirmBulk) {
        if (!bulkRunning) {
          setConfirmBulk(null);
          setBulkError(null);
        }
        return;
      }
      if (confirmTarget) {
        if (!resolving) {
          setConfirmTarget(null);
          setResolveError(null);
        }
        return;
      }
      if (!bulkRunning) {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, confirmTarget, confirmBulk, resolving, bulkRunning, onClose]);

  useEffect(() => {
    if (!statusNotice) return;
    const timer = window.setTimeout(() => setStatusNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [statusNotice]);

  const isCopyPlaying = useCallback(
    (copy: DuplicateCopyItem): boolean => {
      if (copy.isPlaying) return true;
      return activeNumericTrackId !== null && activeNumericTrackId === copy.id;
    },
    [activeNumericTrackId]
  );

  const liveBulkPlan = useMemo(() => {
    let removableCopies = 0;
    let safeGroups = 0;
    let skippedGroups = 0;
    for (const group of groups) {
      const hasPlaying = group.copies.some((c) => isCopyPlaying(c));
      const isSafe = Boolean(group.safeForBulk) && !hasPlaying && group.copies.length >= 2;
      if (isSafe) {
        safeGroups += 1;
        removableCopies += Math.max(0, group.copies.length - 1);
      } else {
        skippedGroups += 1;
      }
    }
    return {removableCopies, safeGroups, skippedGroups};
  }, [groups, isCopyPlaying]);

  if (!open) return null;

  const pickKeepCopyForRemoval = (
    group: DuplicateGroupItem,
    removeCopy: DuplicateCopyItem
  ): DuplicateCopyItem | null => {
    if (group.suggestedKeepId !== removeCopy.id) {
      const suggested = group.copies.find((c) => c.id === group.suggestedKeepId);
      if (suggested) return suggested;
    }
    return group.copies.find((c) => c.id !== removeCopy.id) ?? null;
  };

  const handleRequestRemove = (group: DuplicateGroupItem, copy: DuplicateCopyItem) => {
    if (group.copies.length <= 1 || isCopyPlaying(copy) || bulkRunning) return;
    const keepCopy = pickKeepCopyForRemoval(group, copy);
    if (!keepCopy) return;
    setResolveError(null);
    setConfirmTarget({group, removeCopy: copy, keepCopy});
  };

  const handleConfirmRemove = async () => {
    if (!confirmTarget || resolving || bulkRunning) return;
    const {group, removeCopy, keepCopy} = confirmTarget;
    setResolving(true);
    setResolveError(null);

    try {
      const res = await apiFetch<ResolveDuplicateResponse>('/api/library/duplicates/resolve', {
        method: 'POST',
        body: JSON.stringify({
          keepId: keepCopy.id,
          removeId: removeCopy.id,
          ...(activeNumericTrackId ? {playingTrackId: activeNumericTrackId} : {}),
        }),
      });

      // Update groups in place without re-scanning the entire library
      setGroups((prev) => {
        if (res.remainingGroup && res.remainingGroup.copies.length > 1) {
          return prev.map((g) => (g.id === group.id ? res.remainingGroup! : g));
        }
        return prev.filter((g) => g.id !== group.id);
      });

      // Sync queue, likes, and Home library list without interrupting playback
      if (res.keepTrack) {
        replaceDuplicateInQueue(res.removeId, res.keepTrack);
        syncTrackLikeState(res.keepId, res.keepLiked);
        onDuplicateRemoved?.({
          removeId: res.removeId,
          keepTrack: res.keepTrack,
          keepLiked: res.keepLiked,
          playlistsUpdated: res.playlistsUpdated,
        });
      }
      bumpLibraryRefresh();

      const plSummary =
        res.playlistsUpdated > 0
          ? ` · updated ${res.playlistsUpdated} ${res.playlistsUpdated === 1 ? 'playlist' : 'playlists'}`
          : '';
      setStatusNotice(`Removed duplicate copy${plSummary}`);
      setConfirmTarget(null);
    } catch (err) {
      setResolveError(err instanceof Error ? err.message : 'Failed to remove duplicate copy');
    } finally {
      setResolving(false);
    }
  };

  const handleRequestBulkRemove = () => {
    if (liveBulkPlan.removableCopies <= 0 || bulkRunning || resolving || loading) return;
    setBulkError(null);
    setConfirmBulk({
      removableCopies: liveBulkPlan.removableCopies,
      safeGroups: liveBulkPlan.safeGroups,
      skippedGroups: liveBulkPlan.skippedGroups,
    });
  };

  const handleConfirmBulkRemove = async () => {
    if (!confirmBulk || bulkRunning) return;
    const plannedTotal = confirmBulk.removableCopies;
    setConfirmBulk(null);
    setBulkRunning(true);
    setBulkError(null);
    setBulkSummary(null);
    setBulkProgress({removed: 0, total: plannedTotal});

    const appliedReplacementIds = new Set<number>();
    const allReplacements: BulkResolvedReplacementItem[] = [];

    const applyReplacements = (items: BulkResolvedReplacementItem[] | undefined) => {
      if (!items || items.length === 0) return;
      for (const item of items) {
        if (appliedReplacementIds.has(item.removeId)) continue;
        appliedReplacementIds.add(item.removeId);
        allReplacements.push(item);
        if (item.keepTrack) {
          replaceDuplicateInQueue(item.removeId, item.keepTrack);
          syncTrackLikeState(item.keepId, item.keepLiked);
        }
      }
    };

    try {
      const token = getStoredToken();
      const headers = new Headers({
        'Content-Type': 'application/json',
        Accept: 'application/x-ndjson',
      });
      if (token) {
        headers.set('Authorization', `Bearer ${token}`);
      }

      const playingId = activePlayingIdRef.current;
      const response = await fetch('/api/library/duplicates/resolve-all', {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify(playingId ? {playingTrackId: playingId} : {}),
      });

      if (!response.ok) {
        let message = `Request failed (${response.status})`;
        try {
          const errJson = (await response.json()) as {error?: string};
          if (errJson.error) message = errJson.error;
        } catch {
          // ignore non-JSON body
        }
        throw new Error(message);
      }

      let finalSummary: BulkResolveSummaryResponse | null = null;
      const contentType = response.headers.get('content-type') || '';

      if (contentType.includes('application/x-ndjson') && response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        const processLine = (rawLine: string) => {
          const line = rawLine.trim();
          if (!line) return;
          const ev = JSON.parse(line) as BulkStreamEvent;
          if (ev.type === 'start') {
            setBulkProgress({removed: 0, total: ev.totalPlanned});
          } else if (ev.type === 'progress') {
            setBulkProgress({removed: ev.removedCount, total: ev.totalPlanned});
            applyReplacements(ev.replacements);
          } else if (ev.type === 'done') {
            finalSummary = ev.summary;
            setBulkProgress({
              removed: ev.summary.removedCount,
              total: ev.summary.totalPlanned,
            });
            applyReplacements(ev.summary.replacements);
          } else if (ev.type === 'error') {
            throw new Error(ev.error || 'Bulk duplicate removal failed');
          }
        };

        while (true) {
          const {value, done} = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, {stream: true});
          let nlIdx = buffer.indexOf('\n');
          while (nlIdx !== -1) {
            const line = buffer.slice(0, nlIdx);
            buffer = buffer.slice(nlIdx + 1);
            processLine(line);
            nlIdx = buffer.indexOf('\n');
          }
        }
        buffer += decoder.decode();
        if (buffer.trim()) {
          processLine(buffer);
        }
      } else {
        const json = (await response.json()) as BulkResolveSummaryResponse;
        finalSummary = json;
        setBulkProgress({removed: json.removedCount, total: json.totalPlanned});
        applyReplacements(json.replacements);
      }

      if (finalSummary) {
        setBulkSummary(finalSummary);
      }
      if (allReplacements.length > 0) {
        onBulkDuplicatesRemoved?.(allReplacements);
      }
      bumpLibraryRefresh();
      await fetchDuplicates();
    } catch (err) {
      setBulkError(err instanceof Error ? err.message : 'Bulk duplicate removal failed');
      if (allReplacements.length > 0) {
        onBulkDuplicatesRemoved?.(allReplacements);
        bumpLibraryRefresh();
        await fetchDuplicates();
      }
    } finally {
      setBulkRunning(false);
      setBulkProgress(null);
    }
  };

  const totalExtraCopies = groups.reduce((acc, g) => acc + Math.max(0, g.copies.length - 1), 0);

  const panelContent = (
    <div className="flex h-full flex-col min-h-0">
      {/* Header */}
      <div className="border-b border-[var(--border-subtle)] px-4 sm:px-5 py-3.5 shrink-0 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)] shrink-0">
              <Copy className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-bold text-[var(--text-primary)] leading-tight truncate">
                Duplicates
              </h2>
              <p className="text-xs text-[var(--text-secondary)] truncate">
                {loading
                  ? 'Checking your whole library...'
                  : groups.length === 0
                    ? 'Whole library checked'
                    : `${groups.length} ${groups.length === 1 ? 'group' : 'groups'}, ${totalExtraCopies} extra ${totalExtraCopies === 1 ? 'copy' : 'copies'}`}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => void fetchDuplicates()}
              disabled={loading || resolving || bulkRunning}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--surface-overlay)] hover:text-[var(--text-primary)] disabled:opacity-40 transition-colors"
              title="Re-scan for duplicates"
              aria-label="Re-scan for duplicates"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              type="button"
              onClick={onClose}
              disabled={bulkRunning}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--surface-overlay)] hover:text-[var(--text-primary)] disabled:opacity-40 transition-colors"
              title="Close duplicates panel"
              aria-label="Close duplicates panel"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Primary Bulk Action Button */}
        <button
          type="button"
          disabled={liveBulkPlan.removableCopies === 0 || loading || resolving || bulkRunning}
          onClick={handleRequestBulkRemove}
          className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-[var(--accent)] px-4 py-2.5 text-xs font-bold text-[var(--accent-contrast)] shadow-sm hover:bg-[var(--accent-hover)] disabled:opacity-45 disabled:cursor-not-allowed transition-colors"
        >
          {bulkRunning ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin shrink-0" />
              <span>
                Removed {bulkProgress?.removed ?? 0} of {bulkProgress?.total ?? 0}
              </span>
            </>
          ) : (
            <>
              <Sparkles className="w-4 h-4 shrink-0" />
              <span>Remove all suggested duplicates ({liveBulkPlan.removableCopies})</span>
            </>
          )}
        </button>
      </div>

      {/* Live Bulk Progress Bar */}
      {bulkRunning && bulkProgress && (
        <div className="mx-4 sm:mx-5 mt-3 rounded-xl border border-[var(--accent)]/30 bg-[var(--accent-soft)]/70 p-3 space-y-2 shrink-0">
          <div className="flex items-center justify-between text-xs font-semibold text-[var(--text-primary)]">
            <span className="inline-flex items-center gap-1.5">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--accent)]" />
              Removed {bulkProgress.removed} of {bulkProgress.total}
            </span>
            <span className="font-mono tabular-nums text-[var(--text-secondary)]">
              {bulkProgress.total > 0
                ? `${Math.min(100, Math.round((bulkProgress.removed / bulkProgress.total) * 100))}%`
                : '0%'}
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-overlay)]">
            <div
              className="h-full rounded-full bg-[var(--accent)] transition-all duration-200"
              style={{
                width:
                  bulkProgress.total > 0
                    ? `${Math.min(100, (bulkProgress.removed / bulkProgress.total) * 100)}%`
                    : '0%',
              }}
            />
          </div>
        </div>
      )}

      {/* Bulk Error Banner */}
      {bulkError && (
        <div className="mx-4 sm:mx-5 mt-3 flex items-start justify-between gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2.5 text-xs text-rose-300 shrink-0">
          <div className="flex items-start gap-2 min-w-0">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{bulkError}</span>
          </div>
          <button
            type="button"
            onClick={() => setBulkError(null)}
            className="text-rose-300/80 hover:text-rose-200 shrink-0"
            aria-label="Dismiss error"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Inline single-removal status notice */}
      {statusNotice && (
        <div className="mx-4 sm:mx-5 mt-3 flex items-center gap-2 rounded-lg border border-[var(--accent)]/30 bg-[var(--accent-soft)] px-3 py-2 text-xs font-medium text-[var(--accent)] shrink-0">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span className="truncate">{statusNotice}</span>
        </div>
      )}

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-4 sm:px-5 py-4 space-y-4">
        {/* Bulk Completion Summary */}
        {bulkSummary && !bulkRunning && (
          <section className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3.5 space-y-3">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <CheckCircle2 className="w-4 h-4 text-[var(--accent)] shrink-0" />
                <h3 className="text-xs font-bold text-[var(--text-primary)]">
                  Bulk cleanup complete
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setBulkSummary(null)}
                className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors shrink-0"
                aria-label="Dismiss summary"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg bg-[var(--surface-overlay)]/60 px-2 py-1.5">
                <p className="font-mono text-sm font-bold text-[var(--accent)] tabular-nums">
                  {bulkSummary.removedCount}
                </p>
                <p className="text-[10px] text-[var(--text-secondary)]">Removed</p>
              </div>
              <div className="rounded-lg bg-[var(--surface-overlay)]/60 px-2 py-1.5">
                <p className="font-mono text-sm font-bold text-amber-400 tabular-nums">
                  {bulkSummary.skippedCount}
                </p>
                <p className="text-[10px] text-[var(--text-secondary)]">Skipped</p>
              </div>
              <div className="rounded-lg bg-[var(--surface-overlay)]/60 px-2 py-1.5">
                <p className="font-mono text-sm font-bold text-rose-400 tabular-nums">
                  {bulkSummary.failedCount}
                </p>
                <p className="text-[10px] text-[var(--text-secondary)]">Failed</p>
              </div>
            </div>

            {bulkSummary.skipped.length > 0 && (
              <div className="space-y-1.5 pt-1 border-t border-[var(--border-subtle)]">
                <p className="text-[11px] font-semibold text-amber-400 flex items-center gap-1">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                  Skipped, review manually ({bulkSummary.skipped.length})
                </p>
                <ul className="space-y-1">
                  {bulkSummary.skipped.map((item) => (
                    <li
                      key={item.groupId}
                      className="text-[11px] text-[var(--text-secondary)] leading-snug"
                    >
                      <span className="font-semibold text-[var(--text-primary)]">
                        {item.title}
                      </span>{' '}
                      <span className="text-[var(--text-muted)]">({item.artist})</span> —{' '}
                      {item.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {bulkSummary.failed.length > 0 && (
              <div className="space-y-1.5 pt-1 border-t border-[var(--border-subtle)]">
                <p className="text-[11px] font-semibold text-rose-400 flex items-center gap-1">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                  Failed ({bulkSummary.failed.length})
                </p>
                <ul className="space-y-1">
                  {bulkSummary.failed.map((item) => (
                    <li
                      key={item.groupId}
                      className="text-[11px] text-rose-300/90 leading-snug"
                    >
                      <span className="font-semibold text-[var(--text-primary)]">
                        {item.title}
                      </span>{' '}
                      <span className="text-[var(--text-muted)]">({item.artist})</span> —{' '}
                      {item.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        )}

        {loading ? (
          <div className="flex flex-col items-center justify-center py-16 text-center gap-3">
            <Loader2 className="w-7 h-7 animate-spin text-[var(--accent)]" />
            <div className="space-y-1">
              <p className="text-sm font-semibold text-[var(--text-primary)]">
                Finding duplicates
              </p>
              <p className="text-xs text-[var(--text-secondary)]">
                Scanning your full library for matching recordings...
              </p>
            </div>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center py-14 text-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-rose-500/15 text-rose-400">
              <AlertCircle className="w-5 h-5" />
            </div>
            <div className="space-y-1 max-w-xs">
              <p className="text-sm font-semibold text-[var(--text-primary)]">
                Could not scan duplicates
              </p>
              <p className="text-xs text-[var(--text-secondary)]">{error}</p>
            </div>
            <button
              type="button"
              onClick={() => void fetchDuplicates()}
              className="mt-1 inline-flex items-center gap-1.5 rounded-lg bg-[var(--surface-overlay)] border border-[var(--border-subtle)] px-3.5 py-2 text-xs font-semibold text-[var(--text-primary)] hover:bg-[var(--surface-overlay-hover)] transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Try again
            </button>
          </div>
        ) : groups.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--accent-soft)] text-[var(--accent)]">
              <CheckCircle2 className="w-6 h-6" />
            </div>
            <div className="space-y-1 max-w-xs">
              <p className="text-base font-semibold text-[var(--text-primary)]">
                No duplicates found
              </p>
              <p className="text-xs text-[var(--text-secondary)]">
                No duplicate recordings were detected across your library.
              </p>
            </div>
          </div>
        ) : (
          groups.map((group) => {
            const lead = group.copies[0];
            const isLastCopyInGroup = group.copies.length <= 1;
            const hasPlayingCopy = group.copies.some((c) => isCopyPlaying(c));
            const groupSafeLive = Boolean(group.safeForBulk) && !hasPlayingCopy;
            const manualReason = hasPlayingCopy
              ? 'Skipped, review manually (currently playing)'
              : group.bulkSkipReason || 'Skipped, review manually';

            return (
              <section
                key={group.id}
                className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] overflow-hidden"
              >
                {/* Group Header */}
                <div className="flex items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-3.5 py-2.5 bg-[var(--surface-overlay)]/40">
                  <div className="min-w-0">
                    <p className="text-xs font-bold text-[var(--text-primary)] truncate">
                      {lead?.title || 'Duplicate song'}
                    </p>
                    <p className="text-[11px] text-[var(--text-secondary)] truncate">
                      {lead?.artist || 'Unknown Artist'} · {group.copies.length}{' '}
                      {group.copies.length === 1 ? 'copy' : 'copies'}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {!groupSafeLive && (
                      <span
                        title={manualReason}
                        className="rounded-md bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-400"
                      >
                        Review manually
                      </span>
                    )}
                    <span
                      className={`rounded-md px-2 py-0.5 text-[11px] font-semibold ${
                        group.matchType === 'definite'
                          ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                          : 'bg-[var(--surface-overlay)] text-[var(--text-secondary)] border border-[var(--border-subtle)]'
                      }`}
                    >
                      {group.label}
                    </span>
                  </div>
                </div>

                {/* Copies List */}
                <div className="divide-y divide-[var(--border-subtle)]">
                  {group.copies.map((copy) => {
                    const playingNow = isCopyPlaying(copy);
                    const removeDisabled =
                      isLastCopyInGroup || playingNow || resolving || bulkRunning;
                    const disabledTooltip = playingNow
                      ? 'Playing now'
                      : isLastCopyInGroup
                        ? 'Last remaining copy'
                        : undefined;

                    return (
                      <div key={copy.id} className="p-3.5 space-y-2.5">
                        <div className="flex items-start gap-3 min-w-0">
                          <AlbumArt
                            coverFile={copy.cover_file}
                            alt={copy.title}
                            color={copy.dominant_color}
                            className="w-11 h-11 rounded-lg shrink-0"
                            iconSize={18}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="text-sm font-semibold text-[var(--text-primary)] truncate max-w-full">
                                {copy.title}
                              </span>
                              {copy.suggestedKeep && (
                                <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide bg-[var(--accent-soft)] text-[var(--accent)] shrink-0">
                                  Suggested
                                </span>
                              )}
                              {playingNow && (
                                <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold bg-emerald-500/15 text-emerald-400 shrink-0">
                                  <Volume2 className="w-3 h-3" />
                                  Playing now
                                </span>
                              )}
                            </div>

                            <p className="text-xs text-[var(--text-secondary)] truncate mt-0.5">
                              {copy.artist}
                              {copy.duration > 0 ? (
                                <>
                                  <span className="mx-1.5 text-[var(--text-muted)]">·</span>
                                  <span className="font-mono tabular-nums">
                                    {formatDuration(copy.duration)}
                                  </span>
                                </>
                              ) : null}
                            </p>

                            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[var(--text-muted)]">
                              <span className="inline-flex items-center gap-1 text-[var(--text-secondary)] font-medium">
                                <Disc3 className="w-3 h-3 shrink-0 opacity-75" />
                                {copy.sourceLabel}
                              </span>
                              <span aria-hidden="true">·</span>
                              <span className="font-mono tabular-nums text-[var(--text-secondary)]">
                                {copy.qualityLabel}
                              </span>
                              <span aria-hidden="true">·</span>
                              <span>
                                in {copy.playlistCount}{' '}
                                {copy.playlistCount === 1 ? 'playlist' : 'playlists'}
                              </span>
                              {copy.liked && (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <span className="inline-flex items-center gap-0.5 text-[var(--accent)]">
                                    <Heart className="w-3 h-3 fill-current" />
                                    Liked
                                  </span>
                                </>
                              )}
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center justify-end">
                          <span title={disabledTooltip} className="inline-flex">
                            <button
                              type="button"
                              disabled={removeDisabled}
                              title={disabledTooltip}
                              onClick={() => handleRequestRemove(group, copy)}
                              className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors ${
                                removeDisabled
                                  ? 'border-[var(--border-subtle)] bg-transparent text-[var(--text-muted)] opacity-50 cursor-not-allowed'
                                  : 'border-rose-500/30 bg-rose-500/10 text-rose-400 hover:bg-rose-500/20 hover:border-rose-500/50'
                              }`}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                              <span>Remove this copy</span>
                            </button>
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })
        )}
      </div>

      {/* Single-Copy Confirmation Dialog */}
      {confirmTarget && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/65 backdrop-blur-xs p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-duplicate-remove-title"
          onClick={() => {
            if (!resolving) {
              setConfirmTarget(null);
              setResolveError(null);
            }
          }}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-5 shadow-2xl space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="space-y-1.5">
              <h3
                id="confirm-duplicate-remove-title"
                className="text-base font-bold text-[var(--text-primary)]"
              >
                Remove duplicate copy
              </h3>
              <p className="text-sm text-[var(--text-secondary)] leading-relaxed">
                Remove this copy? It will be replaced by the copy you keep in all your playlists,
                favourites and queue.
              </p>
            </div>

            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3 space-y-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[var(--text-muted)] shrink-0">Removing</span>
                <span className="font-medium text-rose-400 truncate text-right">
                  {confirmTarget.removeCopy.title} ({confirmTarget.removeCopy.qualityLabel})
                </span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[var(--text-muted)] shrink-0">Keeping</span>
                <span className="font-medium text-[var(--accent)] truncate text-right">
                  {confirmTarget.keepCopy.title} ({confirmTarget.keepCopy.qualityLabel})
                </span>
              </div>
            </div>

            {resolveError && (
              <div className="flex items-center gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{resolveError}</span>
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                disabled={resolving}
                onClick={() => {
                  setConfirmTarget(null);
                  setResolveError(null);
                }}
                className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-overlay)] px-4 py-2 text-xs font-semibold text-[var(--text-primary)] hover:bg-[var(--surface-overlay-hover)] disabled:opacity-50 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={resolving}
                onClick={() => void handleConfirmRemove()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-4 py-2 text-xs font-semibold text-white hover:bg-rose-500 disabled:opacity-50 transition-colors"
              >
                {resolving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                <span>{resolving ? 'Removing...' : 'Remove'}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk Confirmation Dialog */}
      {confirmBulk && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/65 backdrop-blur-xs p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-bulk-duplicates-title"
          onClick={() => {
            if (!bulkRunning) {
              setConfirmBulk(null);
              setBulkError(null);
            }
          }}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-5 shadow-2xl space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="space-y-1.5">
              <h3
                id="confirm-bulk-duplicates-title"
                className="text-base font-bold text-[var(--text-primary)]"
              >
                Remove all suggested duplicates
              </h3>
              <p className="text-sm text-[var(--text-secondary)] leading-relaxed">
                Remove {confirmBulk.removableCopies}{' '}
                {confirmBulk.removableCopies === 1 ? 'copy' : 'copies'} from{' '}
                {confirmBulk.safeGroups} {confirmBulk.safeGroups === 1 ? 'group' : 'groups'}?{' '}
                {confirmBulk.skippedGroups}{' '}
                {confirmBulk.skippedGroups === 1 ? 'group needs' : 'groups need'} manual review
                and will be skipped. Playlists, favourites and history will be moved to the kept
                copy. Music files are not deleted.
              </p>
            </div>

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                disabled={bulkRunning}
                onClick={() => {
                  setConfirmBulk(null);
                  setBulkError(null);
                }}
                className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-overlay)] px-4 py-2 text-xs font-semibold text-[var(--text-primary)] hover:bg-[var(--surface-overlay-hover)] disabled:opacity-50 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={bulkRunning}
                onClick={() => void handleConfirmBulkRemove()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--accent)] px-4 py-2 text-xs font-bold text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
              >
                <span>Remove all</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  if (isDesktop) {
    return (
      <div className="fixed inset-0 z-50 flex justify-end">
        <div
          className="fixed inset-0 bg-black/45 backdrop-blur-[2px]"
          onClick={() => {
            if (!bulkRunning) onClose();
          }}
          aria-hidden="true"
        />
        <aside
          role="dialog"
          aria-modal="true"
          aria-label="Find duplicates"
          className="relative z-10 flex h-full w-[480px] max-w-[92vw] flex-col border-l border-[var(--border-subtle)] bg-[var(--bg-elevated)] shadow-2xl"
        >
          {panelContent}
        </aside>
      </div>
    );
  }

  // Mobile full-screen sheet
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Find duplicates"
      className="fixed inset-0 z-50 flex flex-col bg-[var(--bg-base)] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
    >
      {panelContent}
    </div>
  );
};
