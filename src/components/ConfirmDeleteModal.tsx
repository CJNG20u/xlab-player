import {AlertTriangle, Loader2, Trash2, X} from 'lucide-react';
import React from 'react';

interface ConfirmDeleteModalProps {
  open: boolean;
  count: number;
  singleTitle?: string;
  deleting: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

export const ConfirmDeleteModal: React.FC<ConfirmDeleteModalProps> = ({
  open,
  count,
  singleTitle,
  deleting,
  error,
  onCancel,
  onConfirm,
}) => {
  if (!open || count <= 0) return null;

  const isBulk = count > 1;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-xs">
      <div
        className="w-full max-w-md rounded-xl bg-[#181818] border border-white/10 p-6 shadow-2xl space-y-5"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-delete-title"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-500/15 text-red-400">
              <AlertTriangle className="w-5 h-5" />
            </div>
            <div>
              <h2 id="confirm-delete-title" className="font-display text-lg font-bold text-white">
                {isBulk ? `Delete ${count} Tracks Permanently?` : 'Delete Track Permanently?'}
              </h2>
              <p className="text-xs text-[#B3B3B3] mt-0.5">This action cannot be undone.</p>
            </div>
          </div>
          <button
            type="button"
            disabled={deleting}
            onClick={onCancel}
            className="flex h-8 w-8 items-center justify-center rounded-full text-[#B3B3B3] hover:bg-[#282828] hover:text-white disabled:opacity-40"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="rounded-lg bg-[#121212] border border-red-500/20 p-4 text-sm text-[#B3B3B3] space-y-1.5">
          {isBulk ? (
            <p>
              <strong className="text-white font-mono tabular-nums">{count} audio files</strong>{' '}
              will be permanently deleted from your NAS music directory, along with any empty
              Album/Artist folders, unused cover art, and all playlist or liked-song references.
            </p>
          ) : (
            <p>
              <strong className="text-white">{singleTitle || 'This track'}</strong> will be
              permanently deleted from disk, along with any empty parent Album/Artist folders,
              unused cover art, and all playlist or liked-song references.
            </p>
          )}
        </div>

        {error && (
          <p className="text-xs font-medium text-red-400">{error}</p>
        )}

        <div className="flex items-center justify-end gap-3 pt-1">
          <button
            type="button"
            disabled={deleting}
            onClick={onCancel}
            className="px-4 py-2 text-sm font-medium text-[#B3B3B3] hover:text-white disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={deleting}
            onClick={onConfirm}
            className="inline-flex items-center gap-2 rounded-full bg-red-600 px-5 py-2.5 text-sm font-bold text-white hover:bg-red-500 disabled:opacity-50 transition-colors"
          >
            {deleting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Deleting...</span>
              </>
            ) : (
              <>
                <Trash2 className="w-4 h-4" />
                <span>{isBulk ? `Delete ${count} Files` : 'Delete Permanently'}</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
