import {ListMusic, X} from 'lucide-react';
import React from 'react';
import {useBackClose} from '../lib/backStack';
import {QueuePanelContent} from './QueuePanelContent';

interface QueueDrawerProps {
  open: boolean;
  onClose: () => void;
}

export const QueueDrawer: React.FC<QueueDrawerProps> = ({open, onClose}) => {
  useBackClose(open, onClose);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div
        className="fixed inset-0 bg-black/55 backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside className="relative z-10 flex h-full w-full max-w-sm flex-col bg-[var(--bg-secondary)] border-l border-[var(--border-subtle)] shadow-2xl pt-safe pb-safe">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-subtle)]">
          <div className="flex items-center gap-2.5">
            <ListMusic className="w-5 h-5 text-[var(--accent)]" />
            <h2 className="font-display text-base font-bold text-[var(--text-primary)]">Up Next Queue</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)] transition-colors"
            aria-label="Close queue"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <QueuePanelContent />
      </aside>
    </div>
  );
};
