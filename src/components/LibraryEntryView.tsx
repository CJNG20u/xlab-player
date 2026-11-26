import {
  ChevronRight,
  CircleArrowDown,
  Copy,
  Disc3,
  HardDriveDownload,
  Heart,
  ListMusic,
  Mic2,
  MoreHorizontal,
  Music2,
  Plus,
} from 'lucide-react';
import React, {useEffect, useRef, useState} from 'react';
import {Link} from 'react-router-dom';
import {useBackClose} from '../lib/backStack';

interface LibraryEntryItem {
  id: 'playlists' | 'artists' | 'albums' | 'songs' | 'downloaded' | 'liked' | 'cached';
  label: string;
  to: string;
  icon: React.ComponentType<{className?: string; strokeWidth?: number}>;
}

const ALL_LIBRARY_ROWS: LibraryEntryItem[] = [
  {id: 'playlists', label: 'Playlists', to: '/library/playlists', icon: ListMusic},
  {id: 'artists', label: 'Artists', to: '/library/artists', icon: Mic2},
  {id: 'albums', label: 'Albums', to: '/library/albums', icon: Disc3},
  {id: 'songs', label: 'Songs', to: '/library/songs', icon: Music2},
  {id: 'downloaded', label: 'Downloaded', to: '/library/downloaded', icon: CircleArrowDown},
  {id: 'liked', label: 'Liked', to: '/library/liked', icon: Heart},
  {id: 'cached', label: 'Cached', to: '/library/cached', icon: HardDriveDownload},
];

interface LibraryEntryViewProps {
  offline: boolean;
  hasOfflinePlaylists: boolean;
  onOpenCreatePlaylist: () => void;
  onOpenDuplicates: () => void;
}

export const LibraryEntryView: React.FC<LibraryEntryViewProps> = ({
  offline,
  hasOfflinePlaylists,
  onOpenCreatePlaylist,
  onOpenDuplicates,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuContainerRef = useRef<HTMLDivElement | null>(null);

  useBackClose(menuOpen, () => setMenuOpen(false));

  useEffect(() => {
    if (!menuOpen) return;
    const handleOutside = (e: MouseEvent | TouchEvent) => {
      if (menuContainerRef.current && !menuContainerRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', handleOutside);
    document.addEventListener('touchstart', handleOutside, {passive: true});
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleOutside);
      document.removeEventListener('touchstart', handleOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [menuOpen]);

  const rows = offline
    ? ALL_LIBRARY_ROWS.filter(
        (row) => row.id === 'cached' || (row.id === 'playlists' && hasOfflinePlaylists)
      )
    : ALL_LIBRARY_ROWS;

  return (
    <div
      className="min-h-full"
      style={{
        paddingTop: 'calc(1rem + env(safe-area-inset-top, 0px))',
        paddingBottom: 'calc(8.5rem + env(safe-area-inset-bottom, 0px))',
      }}
    >
      {/* Top Row: Large Bold "Library" Title + Round Glass "..." Button */}
      <div className="flex items-center justify-between gap-3 px-5 pt-2 pb-4">
        <h1 className="font-display text-[32px] font-extrabold tracking-tight leading-tight text-[var(--text-primary)]">
          Library
        </h1>

        {!offline && (
          <div className="relative" ref={menuContainerRef}>
            <button
              type="button"
              onClick={() => setMenuOpen((prev) => !prev)}
              aria-label="Library options"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              className="flex h-11 w-11 min-h-[44px] min-w-[44px] items-center justify-center rounded-full bg-[var(--bg-elevated)]/80 backdrop-blur-md border border-[var(--border-subtle)] text-[var(--text-primary)] shadow-sm active:scale-95 active:bg-[var(--bg-hover)] transition-all"
            >
              <MoreHorizontal className="w-5 h-5" />
            </button>

            {menuOpen && (
              <div
                role="menu"
                aria-label="Library actions"
                className="absolute right-0 top-[calc(100%+8px)] z-40 w-56 rounded-2xl border border-[var(--border-strong)] bg-[var(--bg-elevated)]/95 backdrop-blur-xl p-1.5 shadow-2xl"
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onOpenCreatePlaylist();
                  }}
                  className="flex w-full min-h-[44px] items-center gap-3 rounded-xl px-3.5 py-2.5 text-left text-[15px] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-hover)] active:bg-[var(--bg-hover)] transition-colors"
                >
                  <Plus className="w-5 h-5 text-[var(--accent)] shrink-0" />
                  <span>New playlist</span>
                </button>
                <div className="mx-3 my-0.5 h-px bg-[var(--border-subtle)]" aria-hidden="true" />
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onOpenDuplicates();
                  }}
                  className="flex w-full min-h-[44px] items-center gap-3 rounded-xl px-3.5 py-2.5 text-left text-[15px] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-hover)] active:bg-[var(--bg-hover)] transition-colors"
                >
                  <Copy className="w-5 h-5 text-[var(--accent)] shrink-0" />
                  <span>Find duplicates</span>
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Apple Music–Style Vertical Entry List */}
      <nav aria-label="Library sections" className="w-full">
        <ul className="w-full">
          {rows.map((row, idx) => {
            const Icon = row.icon;
            const isLast = idx === rows.length - 1;
            return (
              <li key={row.id} className="w-full">
                <Link
                  to={row.to}
                  className="flex w-full min-h-[58px] items-center pl-5 active:bg-[var(--bg-hover)] transition-colors"
                >
                  <span
                    className="flex w-8 shrink-0 items-center justify-center mr-4 text-[var(--accent)]"
                    aria-hidden="true"
                  >
                    <Icon className="w-7 h-7" strokeWidth={1.85} />
                  </span>
                  <span
                    className={`flex flex-1 min-w-0 min-h-[58px] items-center justify-between gap-3 pr-5 ${
                      isLast ? '' : 'border-b border-[var(--border-subtle)]'
                    }`}
                  >
                    <span className="text-[22px] font-normal leading-snug tracking-[-0.01em] text-[var(--text-primary)] truncate">
                      {row.label}
                    </span>
                    <ChevronRight
                      className="w-5 h-5 shrink-0 text-[var(--text-muted)]"
                      aria-hidden="true"
                    />
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
};
