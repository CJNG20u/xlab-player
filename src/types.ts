export interface User {
  id: number;
  username: string;
  role: 'admin' | 'listener';
  can_download: boolean;
  /** When false, a listener only sees songs in public/own playlists plus ones they liked or added. */
  full_library?: boolean;
  created_at: string;
}

export type TrackId = number | string;

export type RecommendationSource = 'autoplay' | 'radio' | 'discover' | 'library' | 'search';

export interface TrackRecommendation {
  source: RecommendationSource;
}

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
  last_played_at?: number | null;
  coverUrl?: string;
  streamUrl?: string;
  isYouTubeStream?: boolean;
  youtubeUrl?: string;
  deezerTrackId?: string;
  deezerAlbumId?: string;
  deezerArtistId?: string;
  filePath?: string;
  queueSource?: 'autoplay' | 'radio';
  sourcePool?: 'related' | 'discovery' | 'local';
  recommendation?: TrackRecommendation;
}

export interface Playlist {
  id: number;
  user_id: number;
  name: string;
  description: string;
  source?: 'manual' | 'm3u';
  m3u_path?: string | null;
  /** private = only the owner and admins can see it; public = every signed-in user can see it. */
  visibility?: 'private' | 'public';
  created_at: string;
  updated_at: string;
  owner_username?: string;
  track_count: number;
  covers: string[];
}

export type SearchSource = 'youtube' | 'ytmusic';
export type DownloadQuality = 'standard' | 'high' | 'ultra';

export interface MetadataPreviewItem {
  id: string;
  url: string;
  title: string;
  artist: string;
  channel?: string;
  album: string;
  duration: number;
  thumbnail_url: string;
  source?: SearchSource;
  duplicateTrack: {id: number; title: string; artist: string; album: string} | null;
}

export interface DownloadJob {
  id: number;
  user_id: number | null;
  url: string;
  title: string;
  artist: string;
  album: string;
  format: 'm4a' | 'opus' | 'mp3' | string;
  quality?: DownloadQuality;
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
  ytdlp_download_quality?: string;
  cookies_status?: string;
  cookies_tested_at?: string;
}

export type RepeatMode = 'off' | 'all' | 'one';

export interface LrcLine {
  time: number | null;
  text: string;
}

export interface DiscoverNewReleaseItem {
  id?: string;
  deezerTrackId?: string;
  videoId?: string;
  url: string;
  title: string;
  artist: string;
  artistId?: string;
  album?: string;
  albumId?: string;
  recordType?: string;
  releaseDate?: string;
  releaseLabel: string;
  duration: number;
  thumbnailUrl: string;
  fallbackThumbnailUrl: string;
  isNew: boolean;
  seedArtist: string | null;
}

export interface DiscoverArtistItem {
  id: string;
  deezerArtistId?: string;
  name: string;
  subtitle: string;
  fans?: number;
  seedArtist: string | null;
  videoId?: string;
  thumbnailUrl: string;
  fallbackThumbnailUrl: string;
}

export interface DiscoverAlbumItem {
  id?: string;
  deezerAlbumId?: string;
  videoId?: string;
  url: string;
  title: string;
  artist: string;
  artistId?: string;
  subtitle: string;
  recordType?: string;
  releaseDate?: string;
  releaseYear?: string;
  trackCount?: number;
  duration: number;
  thumbnailUrl: string;
  fallbackThumbnailUrl: string;
  seedArtist: string | null;
}

export interface YouTubePlaylistSearchItem {
  playlistId: string;
  title: string;
  channel: string;
  videoCount: number | null;
  thumbnail: string;
}

export interface YouTubePlaylistTrackItem {
  videoId: string;
  title: string;
  artist: string;
  channel: string;
  duration: number;
  thumbnail: string;
}

export interface YouTubePlaylistDetail {
  playlistId: string;
  title: string;
  channel: string;
  thumbnail: string;
  tracks: YouTubePlaylistTrackItem[];
}

export type YouTubePlaylistJobState = 'running' | 'completed' | 'cancelled' | 'failed';
export type YouTubePlaylistJobItemStatus = 'pending' | 'downloading' | 'done' | 'failed' | 'cancelled';

export interface YouTubePlaylistJobFailedTrack {
  position: number;
  videoId: string;
  title: string;
  artist: string;
  error: string;
}

export interface YouTubePlaylistJobItem {
  position: number;
  videoId: string;
  title: string;
  artist: string;
  channel: string;
  duration: number;
  thumbnail: string;
  status: YouTubePlaylistJobItemStatus;
  trackId: number | null;
  error: string;
}

export interface YouTubePlaylistJob {
  id: string;
  jobId: string;
  userId: number;
  playlistId: number;
  youtubePlaylistId: string;
  playlistName: string;
  state: YouTubePlaylistJobState;
  total: number;
  done: number;
  failed: number;
  failedTracks: YouTubePlaylistJobFailedTrack[];
  items?: YouTubePlaylistJobItem[];
  createdAt: string;
  updatedAt: string;
}

export interface DiscoverSearchResponse {
  query: string;
  cached: boolean;
  artists: DiscoverArtistItem[];
  albums: DiscoverAlbumItem[];
  tracks: DiscoverAlbumTrack[];
  playlists?: YouTubePlaylistSearchItem[];
}

export interface PlayHistoryEntry {
  title: string;
  artist: string;
  trackId?: number | null;
  videoId?: string;
  playedAt: number;
}

export interface DiscoverFeedResponse {
  seeds: string[];
  basedOnLibrary: boolean;
  basedOnHistory?: boolean;
  lastPlayed?: {
    artist: string;
    title: string;
    playedAt?: number;
  } | null;
  cached: boolean;
  source?: 'deezer' | 'youtube';
  generatedAt: string;
  newReleases: DiscoverNewReleaseItem[];
  artistsToDiscover: DiscoverArtistItem[];
  albumsForYou: DiscoverAlbumItem[];
}

export interface DiscoverAlbumTrack {
  id: string;
  deezerTrackId: string;
  trackNumber: number;
  diskNumber: number;
  title: string;
  artist: string;
  featuredArtists?: string;
  artistId?: string;
  album: string;
  albumId: string;
  duration: number;
  explicit: boolean;
  coverUrl: string;
  videoId?: string;
}

export interface DiscoverAlbumDetail {
  id: string;
  deezerAlbumId: string;
  title: string;
  artist: string;
  artistId?: string;
  artistPictureUrl: string;
  coverUrl: string;
  releaseDate: string;
  releaseYear?: string;
  recordType?: string;
  label: string;
  genre: string;
  trackCount: number;
  duration: number;
  tracks: DiscoverAlbumTrack[];
  cached: boolean;
}

export interface DiscoverArtistAlbumSummary {
  id: string;
  deezerAlbumId: string;
  title: string;
  releaseDate: string;
  rawReleaseDate?: string;
  recordType: string;
  coverUrl: string;
}

export interface DiscoverArtistDetail {
  id: string;
  deezerArtistId: string;
  name: string;
  pictureUrl: string;
  fans: number;
  albumCount: number;
  latestRelease?: DiscoverArtistAlbumSummary | null;
  topTracks: DiscoverAlbumTrack[];
  albums: DiscoverArtistAlbumSummary[];
  relatedArtists: DiscoverArtistItem[];
  cached: boolean;
}

export type AutoplayIntent = 'autoplay' | 'radio';
export type AutoplayPoolName = 'related' | 'discovery' | 'local';

export interface AutoplaySeedInput {
  videoId?: string;
  trackId?: number | string | null;
  title?: string;
  artist?: string;
  album?: string;
  duration?: number;
}

export interface AutoplayPlanRequest {
  seed: AutoplaySeedInput;
  context?: AutoplaySeedInput[];
  exclude?: string[];
  intent: AutoplayIntent;
  limit?: number;
  entropy?: string;
}

export interface AutoplayPlanItem {
  id: string | number;
  videoId: string | null;
  trackId: number | null;
  title: string;
  artist: string;
  album: string;
  duration: number;
  coverUrl?: string;
  cover_file?: string | null;
  dominant_color?: string;
  rel_path?: string;
  track_number?: number | null;
  year?: number | null;
  format?: string;
  bitrate?: number;
  size_bytes?: number;
  added_at?: string;
  liked?: boolean;
  isYouTubeStream: boolean;
  streamUrl?: string;
  youtubeUrl?: string;
  deezerTrackId?: string;
  deezerAlbumId?: string;
  deezerArtistId?: string;
  sourcePool: AutoplayPoolName;
  score: number;
  semanticScore: number;
}

export interface AutoplayPlanResponse {
  items: AutoplayPlanItem[];
  poolCounts: {
    related: number;
    discovery: number;
    local: number;
  };
  degraded: boolean;
}
