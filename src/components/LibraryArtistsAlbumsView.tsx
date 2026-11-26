import {ChevronLeft, ChevronRight, Disc3, Loader2, Mic2, Search, X} from 'lucide-react';
import React, {useMemo, useState} from 'react';
import type {Track} from '../types';
import {AlbumArt} from './AlbumArt';

export interface LibraryArtistGroup {
  key: string;
  name: string;
  queryArtist: string;
  coverFile?: string | null;
  coverUrl?: string | null;
  color?: string | null;
  songCount: number;
}

export interface LibraryAlbumGroup {
  key: string;
  title: string;
  artist: string;
  queryAlbum: string;
  queryArtist: string;
  coverFile?: string | null;
  coverUrl?: string | null;
  color?: string | null;
  songCount: number;
}

export function groupTracksByArtist(tracks: Track[]): LibraryArtistGroup[] {
  const map = new Map<string, LibraryArtistGroup>();
  for (const track of tracks) {
    const trimmed = (track.artist || '').trim();
    const displayName = trimmed || 'Unknown Artist';
    const key = displayName.toLowerCase();
    const existing = map.get(key);
    if (existing) {
      existing.songCount += 1;
      if (!existing.coverFile && !existing.coverUrl && (track.cover_file || track.coverUrl)) {
        existing.coverFile = track.cover_file;
        existing.coverUrl = track.coverUrl;
        existing.color = track.dominant_color;
      }
    } else {
      map.set(key, {
        key,
        name: displayName,
        queryArtist: trimmed || 'Unknown Artist',
        coverFile: track.cover_file,
        coverUrl: track.coverUrl,
        color: track.dominant_color,
        songCount: 1,
      });
    }
  }
  return Array.from(map.values()).sort((a, b) =>
    a.name.localeCompare(b.name, undefined, {sensitivity: 'base'})
  );
}

export function groupTracksByAlbum(tracks: Track[]): LibraryAlbumGroup[] {
  const map = new Map<string, LibraryAlbumGroup>();
  for (const track of tracks) {
    const trimmedAlbum = (track.album || '').trim();
    const trimmedArtist = (track.artist || '').trim();
    const displayTitle = trimmedAlbum || 'Unknown Album';
    const displayArtist = trimmedArtist || 'Unknown Artist';
    const key = `${displayTitle.toLowerCase()}::${displayArtist.toLowerCase()}`;
    const existing = map.get(key);
    if (existing) {
      existing.songCount += 1;
      if (!existing.coverFile && !existing.coverUrl && (track.cover_file || track.coverUrl)) {
        existing.coverFile = track.cover_file;
        existing.coverUrl = track.coverUrl;
        existing.color = track.dominant_color;
      }
    } else {
      map.set(key, {
        key,
        title: displayTitle,
        artist: displayArtist,
        queryAlbum: displayTitle,
        queryArtist: displayArtist,
        coverFile: track.cover_file,
        coverUrl: track.coverUrl,
        color: track.dominant_color,
        songCount: 1,
      });
    }
  }
  return Array.from(map.values()).sort((a, b) => {
    const titleCmp = a.title.localeCompare(b.title, undefined, {sensitivity: 'base'});
    if (titleCmp !== 0) return titleCmp;
    return a.artist.localeCompare(b.artist, undefined, {sensitivity: 'base'});
  });
}

interface LibraryArtistsViewProps {
  tracks: Track[];
  loading: boolean;
  isDesktop: boolean;
  onBack: () => void;
  onSelectArtist: (artistName: string) => void;
  desktopHeader?: React.ReactNode;
}

export const LibraryArtistsView: React.FC<LibraryArtistsViewProps> = ({
  tracks,
  loading,
  isDesktop,
  onBack,
  onSelectArtist,
  desktopHeader,
}) => {
  const [query, setQuery] = useState('');

  const artists = useMemo(() => groupTracksByArtist(tracks), [tracks]);
  const filteredArtists = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return artists;
    return artists.filter((a) => a.name.toLowerCase().includes(q));
  }, [artists, query]);

  return (
    <div
      className={`px-4 sm:px-6 lg:px-8 ${isDesktop ? 'max-w-[1680px]' : 'max-w-7xl'} mx-auto`}
      style={{
        paddingTop: isDesktop
          ? '1rem'
          : 'calc(0.75rem + env(safe-area-inset-top, 0px))',
        paddingBottom: 'calc(8.5rem + env(safe-area-inset-bottom, 0px))',
      }}
    >
      {isDesktop ? (
        desktopHeader
      ) : (
        <div className="mb-4 space-y-1.5">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex min-h-[44px] -ml-2 items-center gap-1 rounded-full pl-1 pr-3 text-base font-medium text-[var(--accent)] active:opacity-70 transition-opacity"
            aria-label="Back to Library"
          >
            <ChevronLeft className="w-6 h-6 -mr-0.5" />
            <span>Library</span>
          </button>
          <h1 className="font-display text-[32px] font-extrabold tracking-tight leading-tight text-[var(--text-primary)]">
            Artists
          </h1>
        </div>
      )}

      {/* Search Field */}
      <div className="relative mb-4 max-w-md">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find in Artists"
          aria-label="Filter artists"
          className="w-full min-h-[44px] rounded-xl bg-[var(--bg-input)] border border-[var(--border-subtle)] pl-10 pr-10 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery('')}
            aria-label="Clear artist search"
            className="absolute right-2 top-1/2 -translate-y-1/2 flex h-8 w-8 items-center justify-center rounded-full text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16 text-[var(--text-secondary)] gap-2">
          <Loader2 className="w-5 h-5 animate-spin text-[var(--accent)]" />
          <span className="text-sm">Loading artists...</span>
        </div>
      ) : filteredArtists.length === 0 ? (
        <div className="rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] p-10 text-center space-y-2">
          <Mic2 className="w-10 h-10 text-[var(--text-muted)] mx-auto" />
          <h2 className="font-display text-lg font-bold text-[var(--text-primary)]">
            {query ? 'No matching artists' : 'No artists yet'}
          </h2>
          <p className="text-sm text-[var(--text-secondary)]">
            {query
              ? 'Try a different search term.'
              : 'Artists from your library songs will appear here.'}
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-[var(--border-subtle)]">
          {filteredArtists.map((artist) => (
            <li key={artist.key}>
              <button
                type="button"
                onClick={() => onSelectArtist(artist.queryArtist)}
                className="flex w-full min-h-[64px] items-center gap-3.5 py-2.5 px-1.5 rounded-lg text-left hover:bg-[var(--bg-hover)]/60 active:bg-[var(--bg-hover)] transition-colors cursor-pointer"
              >
                <AlbumArt
                  coverFile={artist.coverFile}
                  externalUrl={artist.coverUrl}
                  alt={artist.name}
                  color={artist.color || undefined}
                  className="w-12 h-12 rounded-full shrink-0 shadow-sm"
                  iconSize={20}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-[15px] font-semibold text-[var(--text-primary)] truncate">
                    {artist.name}
                  </p>
                  <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                    <span className="font-mono tabular-nums">{artist.songCount}</span>{' '}
                    {artist.songCount === 1 ? 'song' : 'songs'}
                  </p>
                </div>
                <ChevronRight
                  className="w-4 h-4 shrink-0 text-[var(--text-muted)]"
                  aria-hidden="true"
                />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

interface LibraryAlbumsViewProps {
  tracks: Track[];
  loading: boolean;
  isDesktop: boolean;
  onBack: () => void;
  onSelectAlbum: (albumTitle: string, artistName: string) => void;
  desktopHeader?: React.ReactNode;
}

export const LibraryAlbumsView: React.FC<LibraryAlbumsViewProps> = ({
  tracks,
  loading,
  isDesktop,
  onBack,
  onSelectAlbum,
  desktopHeader,
}) => {
  const [query, setQuery] = useState('');

  const albums = useMemo(() => groupTracksByAlbum(tracks), [tracks]);
  const filteredAlbums = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return albums;
    return albums.filter(
      (a) => a.title.toLowerCase().includes(q) || a.artist.toLowerCase().includes(q)
    );
  }, [albums, query]);

  return (
    <div
      className={`px-4 sm:px-6 lg:px-8 ${isDesktop ? 'max-w-[1680px]' : 'max-w-7xl'} mx-auto`}
      style={{
        paddingTop: isDesktop
          ? '1rem'
          : 'calc(0.75rem + env(safe-area-inset-top, 0px))',
        paddingBottom: 'calc(8.5rem + env(safe-area-inset-bottom, 0px))',
      }}
    >
      {isDesktop ? (
        desktopHeader
      ) : (
        <div className="mb-4 space-y-1.5">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex min-h-[44px] -ml-2 items-center gap-1 rounded-full pl-1 pr-3 text-base font-medium text-[var(--accent)] active:opacity-70 transition-opacity"
            aria-label="Back to Library"
          >
            <ChevronLeft className="w-6 h-6 -mr-0.5" />
            <span>Library</span>
          </button>
          <h1 className="font-display text-[32px] font-extrabold tracking-tight leading-tight text-[var(--text-primary)]">
            Albums
          </h1>
        </div>
      )}

      {/* Search Field */}
      <div className="relative mb-4 max-w-md">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find in Albums"
          aria-label="Filter albums"
          className="w-full min-h-[44px] rounded-xl bg-[var(--bg-input)] border border-[var(--border-subtle)] pl-10 pr-10 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery('')}
            aria-label="Clear album search"
            className="absolute right-2 top-1/2 -translate-y-1/2 flex h-8 w-8 items-center justify-center rounded-full text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16 text-[var(--text-secondary)] gap-2">
          <Loader2 className="w-5 h-5 animate-spin text-[var(--accent)]" />
          <span className="text-sm">Loading albums...</span>
        </div>
      ) : filteredAlbums.length === 0 ? (
        <div className="rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] p-10 text-center space-y-2">
          <Disc3 className="w-10 h-10 text-[var(--text-muted)] mx-auto" />
          <h2 className="font-display text-lg font-bold text-[var(--text-primary)]">
            {query ? 'No matching albums' : 'No albums yet'}
          </h2>
          <p className="text-sm text-[var(--text-secondary)]">
            {query
              ? 'Try a different search term.'
              : 'Albums from your library songs will appear here.'}
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-[var(--border-subtle)]">
          {filteredAlbums.map((album) => (
            <li key={album.key}>
              <button
                type="button"
                onClick={() => onSelectAlbum(album.queryAlbum, album.queryArtist)}
                className="flex w-full min-h-[68px] items-center gap-3.5 py-2.5 px-1.5 rounded-lg text-left hover:bg-[var(--bg-hover)]/60 active:bg-[var(--bg-hover)] transition-colors cursor-pointer"
              >
                <AlbumArt
                  coverFile={album.coverFile}
                  externalUrl={album.coverUrl}
                  alt={album.title}
                  color={album.color || undefined}
                  className="w-12 h-12 rounded-lg shrink-0 shadow-sm"
                  iconSize={20}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-[15px] font-semibold text-[var(--text-primary)] truncate">
                    {album.title}
                  </p>
                  <p className="text-xs text-[var(--text-secondary)] truncate mt-0.5">
                    {album.artist}
                    <span className="mx-1.5 text-[var(--text-muted)]" aria-hidden="true">
                      ·
                    </span>
                    <span className="font-mono tabular-nums">{album.songCount}</span>{' '}
                    {album.songCount === 1 ? 'song' : 'songs'}
                  </p>
                </div>
                <ChevronRight
                  className="w-4 h-4 shrink-0 text-[var(--text-muted)]"
                  aria-hidden="true"
                />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
