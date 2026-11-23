import {
  AlertTriangle,
  ArrowUp,
  CheckCircle2,
  ChevronRight,
  Folder,
  HardDrive,
  Loader2,
  X,
} from 'lucide-react';
import React, {useCallback, useEffect, useState} from 'react';
import {apiFetch, formatBytes} from '../lib/api';
import {useBackClose} from '../lib/backStack';
import type {MountHealth} from '../types';

interface DirEntry {
  name: string;
  path: string;
  readable: boolean;
  writable: boolean;
}

interface BrowseResponse {
  currentPath: string;
  parentPath: string | null;
  entries: DirEntry[];
  quickPaths: Array<{label: string; path: string}>;
  health: MountHealth;
}

interface DirectoryBrowserModalProps {
  open: boolean;
  initialPath: string;
  onClose: () => void;
  onSelect: (selectedPath: string) => void;
}

export const DirectoryBrowserModal: React.FC<DirectoryBrowserModalProps> = ({
  open,
  initialPath,
  onClose,
  onSelect,
}) => {
  const [data, setData] = useState<BrowseResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadDir = useCallback(async (targetPath: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<BrowseResponse>(
        `/api/admin/browse-dirs?path=${encodeURIComponent(targetPath)}`
      );
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to browse directory');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      void loadDir(initialPath || '/mnt');
    }
  }, [open, initialPath, loadDir]);

  useBackClose(open, onClose);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-xs">
      <div className="flex max-h-[82vh] w-full max-w-2xl flex-col rounded-2xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border-subtle)]">
          <div className="flex items-center gap-2.5">
            <HardDrive className="w-5 h-5 text-[var(--accent)]" />
            <h2 className="font-display text-lg font-bold text-[var(--text-primary)]">
              Select NAS Music Mount Directory
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]"
            aria-label="Close directory browser"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Quick shortcuts */}
        {data && data.quickPaths.length > 0 && (
          <div className="flex items-center gap-2 overflow-x-auto px-6 py-3 bg-[var(--bg-primary)]/50 border-b border-[var(--border-subtle)]">
            <span className="text-xs text-[var(--text-muted)] shrink-0">Jump to:</span>
            {data.quickPaths.map((q) => (
              <button
                key={q.path}
                type="button"
                onClick={() => void loadDir(q.path)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  data.currentPath === q.path
                    ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)]'
                    : 'bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
                }`}
              >
                {q.label}
              </button>
            ))}
          </div>
        )}

        {/* Current Path Bar */}
        <div className="flex items-center gap-3 px-6 py-3 border-b border-[var(--border-subtle)] bg-[var(--bg-primary)]">
          <button
            type="button"
            disabled={!data?.parentPath || loading}
            onClick={() => data?.parentPath && void loadDir(data.parentPath)}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[var(--bg-elevated)] text-[var(--text-primary)] hover:opacity-90 disabled:opacity-40 transition-opacity"
            title="Parent directory"
          >
            <ArrowUp className="w-4 h-4" />
          </button>
          <div className="min-w-0 flex-1 font-mono text-sm text-[var(--text-primary)] truncate">
            {data?.currentPath || initialPath}
          </div>
          {data?.health && (
            <div className="flex items-center gap-1.5 text-xs shrink-0">
              {data.health.status === 'ok' ? (
                <>
                  <CheckCircle2 className="w-4 h-4 text-[var(--accent)]" />
                  <span className="text-[var(--accent)]">Read & Write</span>
                </>
              ) : (
                <>
                  <AlertTriangle className="w-4 h-4 text-[var(--warn-text)]" />
                  <span className="text-[var(--warn-text)]">Read-Only</span>
                </>
              )}
              {data.health.freeBytes !== null && (
                <span className="text-[var(--text-muted)] font-mono tabular-nums ml-1">
                  · {formatBytes(data.health.freeBytes)} free
                </span>
              )}
            </div>
          )}
        </div>

        {/* Folder listing */}
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-[var(--text-secondary)] gap-2">
              <Loader2 className="w-5 h-5 animate-spin text-[var(--accent)]" />
              <span className="text-sm">Reading filesystem...</span>
            </div>
          ) : error ? (
            <div className="rounded-md bg-[var(--danger-bg)] border border-[var(--danger-border)] p-4 text-sm text-[var(--danger-text)]">
              {error}
            </div>
          ) : data && data.entries.length === 0 ? (
            <div className="py-12 text-center text-sm text-[var(--text-secondary)]">
              No subdirectories inside this folder.
            </div>
          ) : (
            <ul className="divide-y divide-[var(--border-subtle)]">
              {data?.entries.map((entry) => (
                <li key={entry.path}>
                  <button
                    type="button"
                    disabled={!entry.readable}
                    onClick={() => void loadDir(entry.path)}
                    className="flex w-full items-center justify-between gap-3 rounded-md px-3 py-2.5 text-left hover:bg-[var(--bg-hover)] disabled:opacity-40 transition-colors"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <Folder className="w-4 h-4 text-[var(--accent)] shrink-0" />
                      <span className="text-sm text-[var(--text-primary)] truncate">{entry.name}</span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 text-xs text-[var(--text-muted)]">
                      <span>{entry.writable ? 'R/W' : entry.readable ? 'Read-only' : 'No access'}</span>
                      <ChevronRight className="w-4 h-4" />
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-4 px-6 py-4 border-t border-[var(--border-subtle)] bg-[var(--bg-primary)]/50">
          <p className="text-xs text-[var(--text-secondary)] truncate">
            Selected: <span className="font-mono text-[var(--text-primary)]">{data?.currentPath || initialPath}</span>
          </p>
          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!data?.currentPath}
              onClick={() => {
                if (data?.currentPath) {
                  onSelect(data.currentPath);
                  onClose();
                }
              }}
              className="rounded-full bg-[var(--accent)] px-5 py-2 text-sm font-bold text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)] disabled:opacity-40 transition-colors whitespace-nowrap"
            >
              Use This Folder
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
