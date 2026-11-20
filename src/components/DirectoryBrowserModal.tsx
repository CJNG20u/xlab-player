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

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-xs">
      <div className="flex max-h-[82vh] w-full max-w-2xl flex-col rounded-xl bg-[#181818] border border-white/10 shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
          <div className="flex items-center gap-2.5">
            <HardDrive className="w-5 h-5 text-[#1DB954]" />
            <h2 className="font-display text-lg font-bold text-white">
              Select NAS Music Mount Directory
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-full text-[#B3B3B3] hover:bg-[#282828] hover:text-white"
            aria-label="Close directory browser"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Quick shortcuts */}
        {data && data.quickPaths.length > 0 && (
          <div className="flex items-center gap-2 overflow-x-auto px-6 py-3 bg-[#141414] border-b border-white/5">
            <span className="text-xs text-[#6A6A6A] shrink-0">Jump to:</span>
            {data.quickPaths.map((q) => (
              <button
                key={q.path}
                type="button"
                onClick={() => void loadDir(q.path)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  data.currentPath === q.path
                    ? 'bg-[#282828] text-white'
                    : 'bg-[#181818] text-[#B3B3B3] hover:bg-[#282828] hover:text-white'
                }`}
              >
                {q.label}
              </button>
            ))}
          </div>
        )}

        {/* Current Path Bar */}
        <div className="flex items-center gap-3 px-6 py-3 border-b border-white/10 bg-[#121212]">
          <button
            type="button"
            disabled={!data?.parentPath || loading}
            onClick={() => data?.parentPath && void loadDir(data.parentPath)}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[#282828] text-white hover:bg-[#333333] disabled:opacity-40 transition-colors"
            title="Parent directory"
          >
            <ArrowUp className="w-4 h-4" />
          </button>
          <div className="min-w-0 flex-1 font-mono text-sm text-white truncate">
            {data?.currentPath || initialPath}
          </div>
          {data?.health && (
            <div className="flex items-center gap-1.5 text-xs shrink-0">
              {data.health.status === 'ok' ? (
                <>
                  <CheckCircle2 className="w-4 h-4 text-[#1DB954]" />
                  <span className="text-[#1DB954]">Read & Write</span>
                </>
              ) : (
                <>
                  <AlertTriangle className="w-4 h-4 text-amber-400" />
                  <span className="text-amber-400">Read-Only</span>
                </>
              )}
              {data.health.freeBytes !== null && (
                <span className="text-[#6A6A6A] font-mono tabular-nums ml-1">
                  · {formatBytes(data.health.freeBytes)} free
                </span>
              )}
            </div>
          )}
        </div>

        {/* Folder listing */}
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-[#B3B3B3] gap-2">
              <Loader2 className="w-5 h-5 animate-spin text-[#1DB954]" />
              <span className="text-sm">Reading filesystem...</span>
            </div>
          ) : error ? (
            <div className="rounded-md bg-red-500/10 border border-red-500/20 p-4 text-sm text-red-300">
              {error}
            </div>
          ) : data && data.entries.length === 0 ? (
            <div className="py-12 text-center text-sm text-[#B3B3B3]">
              No subdirectories inside this folder.
            </div>
          ) : (
            <ul className="divide-y divide-white/5">
              {data?.entries.map((entry) => (
                <li key={entry.path}>
                  <button
                    type="button"
                    disabled={!entry.readable}
                    onClick={() => void loadDir(entry.path)}
                    className="flex w-full items-center justify-between gap-3 rounded-md px-3 py-2.5 text-left hover:bg-[#282828] disabled:opacity-40 transition-colors"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <Folder className="w-4 h-4 text-[#1DB954] shrink-0" />
                      <span className="text-sm text-white truncate">{entry.name}</span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 text-xs text-[#6A6A6A]">
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
        <div className="flex items-center justify-between gap-4 px-6 py-4 border-t border-white/10 bg-[#141414]">
          <p className="text-xs text-[#B3B3B3] truncate">
            Selected: <span className="font-mono text-white">{data?.currentPath || initialPath}</span>
          </p>
          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-[#B3B3B3] hover:text-white"
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
              className="rounded-full bg-[#1DB954] px-5 py-2 text-sm font-bold text-black hover:bg-[#1ED760] disabled:opacity-40 transition-colors whitespace-nowrap"
            >
              Use This Folder
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
