export interface User {
  id: number;
  username: string;
  role: 'admin' | 'listener';
  can_download: boolean;
  created_at: string;
}

export type TrackId = number | string;

export interface Track {
  id: TrackId;
  rel_path: string;
  title: string;
  artist: string;
  album: string;
  track_number: number | null;
  year: number | null;
  duration: number;
  format: string;
  bitrate: number;
  size_bytes: number;
  cover_file: string | null;
  dominant_color: string;
  added_at: string;
  liked: boolean;
  coverUrl?: string;
  streamUrl?: string;
  isYouTubeStream?: boolean;
  youtubeUrl?: string;
}

export interface Playlist {
  id: number;
  user_id: number;
  name: string;
  description: string;
  source?: 'manual' | 'm3u';
  m3u_path?: string | null;
  created_at: string;
  updated_at: string;
  owner_username?: string;
  track_count: number;
  covers: string[];
}

export interface MetadataPreviewItem {
  id: string;
  url: string;
  title: string;
  artist: string;
  channel?: string;
  album: string;
  duration: number;
  thumbnail_url: string;
  duplicateTrack: {id: number; title: string; artist: string; album: string} | null;
}

export interface DownloadJob {
  id: number;
  user_id: number | null;
  url: string;
  title: string;
  artist: string;
  album: string;
  format: 'm4a' | 'opus';
  status: 'queued' | 'downloading' | 'processing' | 'completed' | 'error';
  progress: number;
  stage: string;
  track_id: number | null;
  error_log: string;
  thumbnail_url: string;
  created_at: string;
  updated_at: string;
}

export interface ScanProgress {
  status: 'idle' | 'scanning' | 'done' | 'error';
  found: number;
  scanned: number;
  imported: number;
  updated: number;
  removed: number;
  playlistsImported?: number;
  currentFile: string;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface MountHealth {
  path: string;
  exists: boolean;
  readable: boolean;
  writable: boolean;
  status: 'ok' | 'read-only' | 'not-found';
  freeBytes: number | null;
  totalBytes: number | null;
}

export interface SystemStatus {
  ytdlp: {installed: boolean; version: string | null; path: string};
  ffmpeg: {installed: boolean; version: string | null; path: string};
  cookies: {
    exists: boolean;
    status: string;
    testedAt: string;
    updatedAt: string | null;
  };
  musicDir: string;
  mountHealth: MountHealth;
  trackCount: number;
  userCount: number;
  scan: ScanProgress;
}

export interface AppSettings {
  music_dir: string;
  ytdlp_path: string;
  ffmpeg_path: string;
  ytdlp_remote_components: string;
  ytdlp_player_client: string;
  ytdlp_sleep_interval: string;
  ytdlp_max_sleep_interval: string;
  ytdlp_force_ipv4: string;
  ytdlp_extra_flags: string;
  ytdlp_crop_cover: string;
  cookies_status?: string;
  cookies_tested_at?: string;
}

export type RepeatMode = 'off' | 'all' | 'one';

export interface LrcLine {
  time: number | null;
  text: string;
}

export interface DiscoverNewReleaseItem {
  videoId: string;
  url: string;
  title: string;
  artist: string;
  releaseLabel: string;
  duration: number;
  thumbnailUrl: string;
  fallbackThumbnailUrl: string;
  isNew: boolean;
  seedArtist: string | null;
}

export interface DiscoverArtistItem {
  id: string;
  name: string;
  subtitle: string;
  seedArtist: string | null;
  videoId: string;
  thumbnailUrl: string;
  fallbackThumbnailUrl: string;
}

export interface DiscoverAlbumItem {
  videoId: string;
  url: string;
  title: string;
  artist: string;
  subtitle: string;
  duration: number;
  thumbnailUrl: string;
  fallbackThumbnailUrl: string;
  seedArtist: string | null;
}

export interface DiscoverFeedResponse {
  seeds: string[];
  basedOnLibrary: boolean;
  cached: boolean;
  generatedAt: string;
  newReleases: DiscoverNewReleaseItem[];
  artistsToDiscover: DiscoverArtistItem[];
  albumsForYou: DiscoverAlbumItem[];
}

