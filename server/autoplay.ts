import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Pure Autoplay & Radio Candidate Pools and Deterministic Queue Planner
// ---------------------------------------------------------------------------

export type AutoplayIntent = 'autoplay' | 'radio';
export type AutoplayPoolName = 'related' | 'discovery' | 'local';

export type PlaybackSourceKind =
  | 'official_audio'
  | 'artist_audio'
  | 'official_video'
  | 'official_lyrics'
  | 'artist_upload'
  | 'unverified'
  | 'third_party_lyrics';

export const MAX_GENERATED_DURATION_SECONDS = 30 * 60; // 30 minutes
export const RELATED_POOL_CAP = 48;
export const LOCAL_POOL_CAP = 48;
export const DISCOVERY_POOL_CAP = 48;
export const AUTOPLAY_CONTEXT_MAX = 5;
export const AUTOPLAY_GRAPH_ANCHORS = 4;
export const DEFAULT_GUMBEL_TEMPERATURE = 0.2;

// Gentle per-user listening-profile score adjustments (named constants so they
// never override same-loop graph membership, pool mix ratios, or artist caps).
export const LISTENING_PROFILE_TOP_ARTIST_MAX_BONUS = 0.08;
export const LISTENING_PROFILE_TOP_ARTIST_SCORE_SATURATION = 6.0;
export const LISTENING_PROFILE_SKIPPED_ARTIST_PENALTY = 0.14;
export const LISTENING_PROFILE_MIN_SCORE = 0.05;

const PLANNER_POOLS: readonly AutoplayPoolName[] = ['related', 'discovery', 'local'];

const INTENT_SEQUENCES: Record<AutoplayIntent, readonly AutoplayPoolName[]> = {
  // 7 related : 1 discovery
  autoplay: [
    'related',
    'related',
    'related',
    'related',
    'related',
    'related',
    'related',
    'discovery',
  ],
  // 6 related : 1 discovery : 1 local
  radio: [
    'related',
    'related',
    'related',
    'related',
    'related',
    'related',
    'discovery',
    'local',
  ],
};

// Upload quality preference:
// official audio > artist audio > official video > official lyrics > artist upload > unverified > third-party lyrics
const SOURCE_RANK: Record<PlaybackSourceKind, number> = {
  official_audio: 70,
  artist_audio: 65,
  official_video: 55,
  official_lyrics: 48,
  artist_upload: 45,
  unverified: 30,
  third_party_lyrics: 15,
};

export interface RelatedRowLike {
  videoId: string;
  title: string;
  artist: string;
  channel?: string;
  duration: number;
  thumbnail: string;
}

export interface RelatedAnchorInput {
  seedVideoId: string;
  rows: RelatedRowLike[];
}

export interface LibraryTrackInput {
  id: number;
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
  liked?: boolean;
  videoId?: string | null;
}

export interface DiscoveryTrackInput {
  videoId: string;
  title: string;
  artist: string;
  album?: string;
  duration: number;
  coverUrl?: string;
  deezerTrackId?: string;
  deezerAlbumId?: string;
  deezerArtistId?: string;
  score?: number;
}

export interface AutoplayCandidate {
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
  playbackSourceKind: PlaybackSourceKind;
  recommendationIdentity: string;
  canonicalIdentity: string;
  score: number;
  semanticScore: number;
}

export interface AutoplayPools {
  related: AutoplayCandidate[];
  discovery: AutoplayCandidate[];
  local: AutoplayCandidate[];
}

export interface ListeningProfileSignal {
  topArtists: Array<{artist: string; score: number}>;
  skippedArtists: string[];
}

export interface PlanAutoplayOptions {
  intent: AutoplayIntent;
  limit?: number;
  exclude?: Iterable<string>;
  contextArtists?: Iterable<string>;
  entropy?: string | null;
  temperature?: number;
  listeningProfile?: ListeningProfileSignal | null;
}

// ---------------------------------------------------------------------------
// Text, Artist & Song Identity Normalization
// ---------------------------------------------------------------------------

function cleanStr(value: unknown): string {
  return String(value ?? '').trim();
}

function foldDiacritics(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Strip YouTube channel noise suffixes such as " - Topic", "(Official)",
 * "[Official]", "(Oficial)", "Official Channel", and "VEVO".
 */
export function cleanArtistName(raw: unknown): string {
  let text = cleanStr(raw);
  if (!text) return '';

  // Repeatedly strip trailing channel-label suffixes so combined labels like
  // "ArtistVEVO - Topic" or "Artist (Official) - Topic" normalize cleanly.
  let prev = '';
  while (text !== prev) {
    prev = text;
    text = text
      .replace(/\s*[-–—]\s*topic$/i, '')
      .replace(/\s*[\(\[]\s*(?:official|oficial)(?:\s+(?:music|artist|audio|video|channel))?\s*[\)\]]$/i, '')
      .replace(/\s+(?:official|oficial)(?:\s+(?:music|artist|audio|video|channel))+$/i, '')
      .replace(/\s+(?:official|oficial)$/i, '')
      .replace(/\s+music\s+channel$/i, '')
      .replace(/(?:^|\s+)?vevo$/i, (m) => (m.toLowerCase() === 'vevo' ? '' : ''))
      .replace(/\s+/g, ' ')
      .trim();
  }

  return text;
}

export function normalizeArtistKey(raw: unknown): string {
  const cleaned = cleanArtistName(raw);
  if (!cleaned) return '';
  return foldDiacritics(cleaned)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Split credited artists on feat./ft./featuring/&/and/x/with/,/+/// and normalize each.
 */
export function extractArtistKeys(raw: unknown): Set<string> {
  const text = cleanStr(raw);
  if (!text) return new Set();

  const parts = text.split(
    /\s+(?:and|x|×|with|vs\.?|feat\.?|ft\.?|featuring)\s+|[,&/+;]/i
  );
  const keys = new Set<string>();
  for (const part of parts) {
    const key = normalizeArtistKey(part);
    if (key) keys.add(key);
  }
  if (keys.size === 0) {
    const whole = normalizeArtistKey(text);
    if (whole) keys.add(whole);
  }
  return keys;
}

/**
 * Strip upload-type tags ("(Official Audio)", "[Official Music Video]", "(Lyrics)", etc.)
 * from a song title so duplicate uploads of the same song collapse to one canonical identity.
 */
export function normalizeTitleForIdentity(raw: unknown): string {
  let title = foldDiacritics(cleanStr(raw)).toLowerCase();
  if (!title) return '';

  // Remove parenthetical/bracketed upload qualifiers & feat credits
  title = title
    .replace(
      /[\(\[]\s*(?:official|oficial|lyric|lyrics|audio|music\s+video|video|visualizer|hd|hq|4k|remastered(?:\s+\d{4})?|explicit|clean|radio\s+edit|album\s+version|feat\.?[^)\]]*|ft\.?[^)\]]*|featuring[^)\]]*)[^)\]]*[\)\]]/gi,
      ' '
    )
    .replace(/\b(?:feat\.?|ft\.?|featuring)\s+.+$/i, ' ')
    .replace(/\bofficial\s+(?:music\s+)?(?:video|audio|lyric\s+video|visualizer)\b/gi, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  return title;
}

/**
 * Canonical `artist::title` identity used to deduplicate different uploads of the same song.
 */
export function canonicalSongIdentity(artist: unknown, title: unknown): string {
  const rawTitle = cleanStr(title);
  let effectiveArtist = cleanArtistName(artist);
  let effectiveTitle = rawTitle;

  // If title is formatted as "Artist - Song", strip duplicated leading artist prefix
  const dashMatch = /^(.{2,60}?)\s+[-–—]\s+(.+)$/.exec(rawTitle);
  if (dashMatch) {
    const leadKey = normalizeArtistKey(dashMatch[1]);
    const artistKey = normalizeArtistKey(effectiveArtist);
    if (leadKey && artistKey && (leadKey === artistKey || artistKey.includes(leadKey) || leadKey.includes(artistKey))) {
      effectiveTitle = dashMatch[2].trim();
    } else if (!artistKey && leadKey) {
      effectiveArtist = cleanArtistName(dashMatch[1]);
      effectiveTitle = dashMatch[2].trim();
    }
  }

  const aKey = normalizeArtistKey(effectiveArtist);
  const tKey = normalizeTitleForIdentity(effectiveTitle);
  if (!tKey) return '';
  return aKey ? `song:${aKey}::${tKey}` : `song::${tKey}`;
}

/**
 * Classify upload source kind so duplicate songs keep:
 * official_audio > artist_audio > official_video > official_lyrics > artist_upload > unverified > third_party_lyrics
 */
export function classifyPlaybackSourceKind(input: {
  title: string;
  artist?: string;
  channel?: string;
  isLocal?: boolean;
  authoritative?: boolean;
}): PlaybackSourceKind {
  if (input.isLocal || input.authoritative) {
    return 'official_audio';
  }

  const rawTitle = cleanStr(input.title).toLowerCase();
  const rawChannel = cleanStr(input.channel || input.artist);
  const lowerChannel = rawChannel.toLowerCase();
  const isTopicChannel = /\s*[-–—]\s*topic$/i.test(rawChannel);
  const isVevoChannel = /vevo$/i.test(rawChannel);
  const isOfficialChannel =
    isTopicChannel ||
    isVevoChannel ||
    /(?:\(|\b)(?:official|oficial)(?:\s+(?:channel|artist|music))?(?:\)|\b)/i.test(rawChannel);

  const artistKey = normalizeArtistKey(input.artist);
  const channelKey = normalizeArtistKey(rawChannel);
  const channelMatchesArtist =
    Boolean(artistKey && channelKey) &&
    (artistKey === channelKey || channelKey.includes(artistKey) || artistKey.includes(channelKey));

  const hasOfficialAudio = /\bofficial\s+audio\b|\bprovided\s+to\s+youtube\b/i.test(rawTitle);
  const hasAudioTag = /\baudio\b/i.test(rawTitle);
  const hasOfficialVideo = /\bofficial\s+(?:music\s+)?video\b|\bmusic\s+video\b|\bofficial\s+mv\b/i.test(
    rawTitle
  );
  const hasLyricsTag = /\blyrics?\b|\bletra\b/i.test(rawTitle);

  if (isTopicChannel || hasOfficialAudio) {
    return 'official_audio';
  }
  if ((isOfficialChannel || channelMatchesArtist) && hasAudioTag && !hasLyricsTag) {
    return 'artist_audio';
  }
  if (hasOfficialVideo || (isVevoChannel && !hasLyricsTag)) {
    return 'official_video';
  }
  if (hasLyricsTag) {
    return isOfficialChannel || channelMatchesArtist ? 'official_lyrics' : 'third_party_lyrics';
  }
  if (isOfficialChannel || channelMatchesArtist) {
    return 'artist_upload';
  }
  if (lowerChannel.includes('lyrics') || lowerChannel.includes('lyric')) {
    return 'third_party_lyrics';
  }
  return 'unverified';
}

export function isGeneratedDurationAllowed(duration: unknown): boolean {
  if (duration === null || duration === undefined || duration === '') return true;
  const num = Number(duration);
  if (!Number.isFinite(num) || num <= 0) return true;
  return num <= MAX_GENERATED_DURATION_SECONDS;
}

export function candidateIdentityKeys(candidate: AutoplayCandidate): Set<string> {
  const keys = new Set<string>();
  const values: Array<string | number | null | undefined> = [
    candidate.recommendationIdentity,
    candidate.canonicalIdentity,
    candidate.videoId,
    candidate.trackId !== null && candidate.trackId !== undefined ? String(candidate.trackId) : null,
    candidate.trackId !== null && candidate.trackId !== undefined ? `music:track:${candidate.trackId}` : null,
    candidate.videoId ? `yt-${candidate.videoId}` : null,
    candidate.videoId ? `music:youtube:${candidate.videoId}` : null,
    candidate.id !== null && candidate.id !== undefined ? String(candidate.id) : null,
  ];
  for (const val of values) {
    const s = cleanStr(val);
    if (s) keys.add(s);
  }
  return keys;
}

function sourceRankOf(kind: PlaybackSourceKind): number {
  return SOURCE_RANK[kind] ?? 0;
}

/**
 * Deduplicate duplicate song identities within a pool, keeping the best upload:
 * official_audio > artist_audio > official_video > official_lyrics > artist_upload > unverified > third_party_lyrics
 */
export function preferBestSongVariants(rows: AutoplayCandidate[]): AutoplayCandidate[] {
  const selected = new Map<string, {index: number; row: AutoplayCandidate}>();
  const passthrough: Array<{index: number; row: AutoplayCandidate}> = [];

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const identity = cleanStr(row.canonicalIdentity);
    if (!identity) {
      passthrough.push({index, row});
      continue;
    }
    const prev = selected.get(identity);
    if (!prev) {
      selected.set(identity, {index, row});
      continue;
    }
    const curRank = sourceRankOf(row.playbackSourceKind);
    const prevRank = sourceRankOf(prev.row.playbackSourceKind);
    if (curRank > prevRank || (curRank === prevRank && row.score > prev.row.score)) {
      selected.set(identity, {index, row});
    }
  }

  const combined = [...passthrough, ...selected.values()];
  combined.sort((a, b) => a.index - b.index);
  return combined.map((entry) => entry.row);
}

// ---------------------------------------------------------------------------
// Pool Builders
// ---------------------------------------------------------------------------

/**
 * Build and score the Related pool from up to 4 recent context anchors (oldest -> newest).
 * Formula:
 *   recency  = 0.64 + 0.36 * ((index + 1) / min(contextLength, 4))
 *   semantic = max(0.18, recency * (1 - min(rank, 24) / 36))
 * Keeps the best score per identity and caps the pool at 48.
 */
export function scoreRelatedPool(
  anchors: RelatedAnchorInput[],
  options: {contextLength?: number; maxPool?: number} = {}
): AutoplayCandidate[] {
  const usedAnchors = anchors.slice(-AUTOPLAY_GRAPH_ANCHORS);
  if (usedAnchors.length === 0) return [];

  const denom = Math.max(
    1,
    Math.min(options.contextLength ?? usedAnchors.length, AUTOPLAY_GRAPH_ANCHORS)
  );
  const maxPool = Math.max(1, Math.min(200, options.maxPool ?? RELATED_POOL_CAP));

  const byIdentity = new Map<string, AutoplayCandidate>();

  for (let index = 0; index < usedAnchors.length; index += 1) {
    const anchor = usedAnchors[index];
    const recency = 0.64 + 0.36 * ((index + 1) / denom);
    const rows = (anchor.rows || []).slice(0, 25);

    for (let rank = 0; rank < rows.length; rank += 1) {
      const row = rows[rank];
      const videoId = cleanStr(row.videoId);
      if (!videoId || videoId === anchor.seedVideoId) continue;

      const semantic = Math.max(0.18, recency * (1 - Math.min(rank, 24) / 36));
      const roundedSemantic = Number(semantic.toFixed(6));
      const artist = cleanArtistName(row.artist || row.channel || '') || 'Unknown Artist';
      const title = cleanStr(row.title) || 'Untitled';
      const duration = Number.isFinite(Number(row.duration)) ? Math.max(0, Math.round(Number(row.duration))) : 0;
      const recommendationIdentity = `music:youtube:${videoId}`;
      const canonicalIdentity = canonicalSongIdentity(artist, title);
      const playbackSourceKind = classifyPlaybackSourceKind({
        title,
        artist,
        channel: row.channel || row.artist,
      });

      const candidate: AutoplayCandidate = {
        id: `yt-${videoId}`,
        videoId,
        trackId: null,
        title,
        artist,
        album: 'YouTube Stream',
        duration,
        coverUrl: cleanStr(row.thumbnail) || `/api/yt-thumb/${encodeURIComponent(videoId)}`,
        dominant_color: '#1f2937',
        format: 'm4a',
        bitrate: 0,
        size_bytes: 0,
        cover_file: null,
        rel_path: '',
        track_number: null,
        year: null,
        added_at: '',
        liked: false,
        isYouTubeStream: true,
        streamUrl: `/api/yt-stream/${encodeURIComponent(videoId)}`,
        youtubeUrl: `https://www.youtube.com/watch?v=${videoId}`,
        sourcePool: 'related',
        playbackSourceKind,
        recommendationIdentity,
        canonicalIdentity,
        score: roundedSemantic,
        semanticScore: roundedSemantic,
      };

      const prev = byIdentity.get(recommendationIdentity);
      if (!prev) {
        byIdentity.set(recommendationIdentity, candidate);
      } else if (
        candidate.score > prev.score ||
        (candidate.score === prev.score &&
          sourceRankOf(candidate.playbackSourceKind) > sourceRankOf(prev.playbackSourceKind))
      ) {
        byIdentity.set(recommendationIdentity, candidate);
      }
    }
  }

  const deduped = preferBestSongVariants(Array.from(byIdentity.values()));
  return deduped
    .map((item, idx) => ({item, idx}))
    .sort((a, b) => (b.item.score !== a.item.score ? b.item.score - a.item.score : a.idx - b.idx))
    .slice(0, maxPool)
    .map((entry) => entry.item);
}

/**
 * Build the Local library pool:
 * - Track artist matches a context artist -> score 0.76
 * - Track artist matches a Deezer related artist -> score 0.62
 */
export function buildLocalPool(
  libraryTracks: LibraryTrackInput[],
  options: {
    contextArtists: Iterable<string>;
    relatedArtists: Iterable<string>;
    likedTrackIds?: Set<number>;
    maxPool?: number;
  }
): AutoplayCandidate[] {
  const contextKeys = new Set<string>();
  for (const a of options.contextArtists) {
    for (const k of extractArtistKeys(a)) contextKeys.add(k);
  }
  const relatedKeys = new Set<string>();
  for (const a of options.relatedArtists) {
    for (const k of extractArtistKeys(a)) relatedKeys.add(k);
  }

  if (contextKeys.size === 0 && relatedKeys.size === 0) return [];

  const maxPool = Math.max(1, Math.min(200, options.maxPool ?? LOCAL_POOL_CAP));
  const candidates: AutoplayCandidate[] = [];

  for (const track of libraryTracks) {
    if (!track || typeof track.id !== 'number') continue;
    const trackArtistKeys = extractArtistKeys(track.artist);
    if (trackArtistKeys.size === 0) continue;

    let score = 0;
    for (const k of trackArtistKeys) {
      if (contextKeys.has(k)) {
        score = Math.max(score, 0.76);
      } else if (relatedKeys.has(k)) {
        score = Math.max(score, 0.62);
      }
    }
    if (score <= 0) continue;

    const liked = Boolean(track.liked || options.likedTrackIds?.has(track.id));
    const videoId = cleanStr(track.videoId) || null;
    const canonicalIdentity = canonicalSongIdentity(track.artist, track.title);

    candidates.push({
      id: track.id,
      videoId,
      trackId: track.id,
      title: track.title,
      artist: track.artist,
      album: track.album,
      duration: Number.isFinite(Number(track.duration)) ? Math.max(0, Number(track.duration)) : 0,
      cover_file: track.cover_file,
      dominant_color: track.dominant_color || '#1f3a2e',
      rel_path: track.rel_path,
      track_number: track.track_number,
      year: track.year,
      format: track.format,
      bitrate: track.bitrate,
      size_bytes: track.size_bytes,
      added_at: track.added_at,
      liked,
      isYouTubeStream: false,
      sourcePool: 'local',
      playbackSourceKind: 'official_audio',
      recommendationIdentity: `music:track:${track.id}`,
      canonicalIdentity,
      score,
      semanticScore: score,
    });
  }

  const deduped = preferBestSongVariants(candidates);
  return deduped
    .map((item, idx) => ({item, idx}))
    .sort((a, b) => {
      if (b.item.score !== a.item.score) return b.item.score - a.item.score;
      const aLiked = a.item.liked ? 1 : 0;
      const bLiked = b.item.liked ? 1 : 0;
      if (bLiked !== aLiked) return bLiked - aLiked;
      return a.idx - b.idx;
    })
    .slice(0, maxPool)
    .map((entry) => entry.item);
}

/**
 * Build the Discovery pool from related artists' Deezer top tracks resolved to YouTube IDs,
 * excluding any track already owned in the user's library.
 */
export function buildDiscoveryPool(
  tracks: DiscoveryTrackInput[],
  options: {
    ownedCanonicalIds?: Set<string>;
    ownedVideoIds?: Set<string>;
    maxPool?: number;
  } = {}
): AutoplayCandidate[] {
  const ownedCanonical = options.ownedCanonicalIds ?? new Set<string>();
  const ownedVideos = options.ownedVideoIds ?? new Set<string>();
  const maxPool = Math.max(1, Math.min(200, options.maxPool ?? DISCOVERY_POOL_CAP));

  const out: AutoplayCandidate[] = [];
  const seenVids = new Set<string>();

  for (const item of tracks) {
    const videoId = cleanStr(item.videoId);
    if (!videoId || seenVids.has(videoId) || ownedVideos.has(videoId)) continue;

    const artist = cleanArtistName(item.artist) || 'Unknown Artist';
    const title = cleanStr(item.title) || 'Untitled';
    const canonicalIdentity = canonicalSongIdentity(artist, title);
    if (canonicalIdentity && ownedCanonical.has(canonicalIdentity)) continue;

    seenVids.add(videoId);
    const score =
      typeof item.score === 'number' && Number.isFinite(item.score) && item.score > 0
        ? item.score
        : 0.62;

    out.push({
      id: `yt-${videoId}`,
      videoId,
      trackId: null,
      title,
      artist,
      album: cleanStr(item.album) || 'Single',
      duration: Number.isFinite(Number(item.duration)) ? Math.max(0, Math.round(Number(item.duration))) : 0,
      coverUrl: cleanStr(item.coverUrl) || `/api/yt-thumb/${encodeURIComponent(videoId)}`,
      cover_file: null,
      dominant_color: '#1f2937',
      rel_path: '',
      track_number: null,
      year: null,
      format: 'm4a',
      bitrate: 0,
      size_bytes: 0,
      added_at: '',
      liked: false,
      isYouTubeStream: true,
      streamUrl: `/api/yt-stream/${encodeURIComponent(videoId)}`,
      youtubeUrl: `https://www.youtube.com/watch?v=${videoId}`,
      deezerTrackId: item.deezerTrackId,
      deezerAlbumId: item.deezerAlbumId,
      deezerArtistId: item.deezerArtistId,
      sourcePool: 'discovery',
      playbackSourceKind: 'official_audio',
      recommendationIdentity: `music:youtube:${videoId}`,
      canonicalIdentity,
      score,
      semanticScore: score,
    });
  }

  const deduped = preferBestSongVariants(out);
  return deduped
    .map((item, idx) => ({item, idx}))
    .sort((a, b) => (b.item.score !== a.item.score ? b.item.score - a.item.score : a.idx - b.idx))
    .slice(0, maxPool)
    .map((entry) => entry.item);
}

// ---------------------------------------------------------------------------
// Deterministic Seeded PRNG + Gumbel-top-k Ranking
// ---------------------------------------------------------------------------

function createSeededRng(seedStr: string): () => number {
  const digest = crypto.createHash('sha256').update(seedStr, 'utf8').digest();
  // 4-state xoshiro128** seeded from SHA-256 digest
  let s0 = digest.readUInt32BE(0) || 0x9e3779b9;
  let s1 = digest.readUInt32BE(4) || 0x243f6a88;
  let s2 = digest.readUInt32BE(8) || 0xb7e15162;
  let s3 = digest.readUInt32BE(12) || 0xdeadbeef;

  const rotl = (x: number, k: number) => ((x << k) | (x >>> (32 - k))) >>> 0;

  return () => {
    const result = (Math.imul(rotl(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0);
    const t = (s1 << 9) >>> 0;
    s2 = (s2 ^ s0) >>> 0;
    s3 = (s3 ^ s1) >>> 0;
    s1 = (s1 ^ s2) >>> 0;
    s0 = (s0 ^ s3) >>> 0;
    s2 = (s2 ^ t) >>> 0;
    s3 = rotl(s3, 11);
    return result / 0x100000000;
  };
}

function rankPoolCandidates(
  rows: AutoplayCandidate[],
  options: {entropy?: string | null; temperature: number; pool: AutoplayPoolName}
): AutoplayCandidate[] {
  const prepared = rows.filter((row) => Boolean(row && cleanStr(row.recommendationIdentity || row.id)));
  if (options.entropy && options.entropy.trim()) {
    const rng = createSeededRng(`${options.entropy.trim()}:${options.pool}`);
    const temp = Math.max(0, options.temperature);
    const scored = prepared.map((row, index) => {
      const uniform = Math.min(1 - 1e-9, Math.max(1e-9, rng()));
      const gumbel = -Math.log(-Math.log(uniform));
      const weighted = Math.log(Math.max(0.0001, row.score || 0)) + temp * gumbel;
      return {weighted, index, row};
    });
    scored.sort((a, b) => (b.weighted !== a.weighted ? b.weighted - a.weighted : a.index - b.index));
    return scored.map((entry) => entry.row);
  }

  return prepared
    .map((row, index) => ({row, index}))
    .sort((a, b) => (b.row.score !== a.row.score ? b.row.score - a.row.score : a.index - b.index))
    .map((entry) => entry.row);
}

// ---------------------------------------------------------------------------
// Pure Queue Planner
// ---------------------------------------------------------------------------

/**
 * Pure deterministic queue planner shared by Autoplay and Radio.
 *
 * - Mix pattern:
 *   - autoplay: 7 related : 1 discovery (repeating)
 *   - radio:    6 related : 1 discovery : 1 local (repeating)
 *   - falls back to other pools when the preferred pool is empty
 * - Artist cap per batch: 2 for autoplay, 3 for radio (counting every credited artist)
 * - Pre-fills the cap with the last 2 context artists so the next songs avoid them
 * - Drops excluded IDs/identities, duplicate songs (keeping best upload), and >30m tracks
 * - Deterministic ranking by score with stable order; optional `entropy` enables
 *   Gumbel-top-k randomization (default temperature 0.2).
 */
export function planAutoplayQueue(
  pools: Partial<AutoplayPools>,
  options: PlanAutoplayOptions
): AutoplayCandidate[] {
  const intent: AutoplayIntent = options.intent === 'radio' ? 'radio' : 'autoplay';
  const limit = Math.max(1, Math.min(24, Math.floor(options.limit ?? 8)));
  const sequence = INTENT_SEQUENCES[intent];
  const artistCap = intent === 'radio' ? 3 : 2;
  const temperature =
    typeof options.temperature === 'number' && Number.isFinite(options.temperature)
      ? Math.max(0, options.temperature)
      : DEFAULT_GUMBEL_TEMPERATURE;

  const seen = new Set<string>();
  if (options.exclude) {
    for (const val of options.exclude) {
      const cleaned = cleanStr(val);
      if (cleaned) seen.add(cleaned);
    }
  }

  const topArtistScores = new Map<string, number>();
  const skippedArtistKeys = new Set<string>();
  if (options.listeningProfile) {
    for (const entry of options.listeningProfile.topArtists || []) {
      if (!entry || !Number.isFinite(entry.score) || entry.score <= 0) continue;
      for (const key of extractArtistKeys(entry.artist)) {
        const prev = topArtistScores.get(key) ?? 0;
        if (entry.score > prev) topArtistScores.set(key, entry.score);
      }
    }
    for (const skipped of options.listeningProfile.skippedArtists || []) {
      for (const key of extractArtistKeys(skipped)) {
        skippedArtistKeys.add(key);
      }
    }
  }

  const applyListeningProfileAdjustment = (baseScore: number, artist: string): number => {
    if (topArtistScores.size === 0 && skippedArtistKeys.size === 0) return baseScore;
    const keys = extractArtistKeys(artist);
    if (keys.size === 0) return baseScore;

    let bestTopScore = 0;
    let isSkipped = false;
    for (const key of keys) {
      if (skippedArtistKeys.has(key)) isSkipped = true;
      const s = topArtistScores.get(key) ?? 0;
      if (s > bestTopScore) bestTopScore = s;
    }

    let delta = 0;
    if (isSkipped) {
      delta -= LISTENING_PROFILE_SKIPPED_ARTIST_PENALTY;
    } else if (bestTopScore > 0) {
      const ratio = Math.min(1, bestTopScore / LISTENING_PROFILE_TOP_ARTIST_SCORE_SATURATION);
      delta += LISTENING_PROFILE_TOP_ARTIST_MAX_BONUS * ratio;
    }
    if (delta === 0) return baseScore;
    return Math.max(LISTENING_PROFILE_MIN_SCORE, Number((baseScore + delta).toFixed(6)));
  };

  const filterAndPreparePool = (rawRows: AutoplayCandidate[] | undefined, poolName: AutoplayPoolName) => {
    const eligible: AutoplayCandidate[] = [];
    for (const row of rawRows || []) {
      if (!row) continue;
      if (!isGeneratedDurationAllowed(row.duration)) continue;
      const keys = candidateIdentityKeys(row);
      let excluded = false;
      for (const k of keys) {
        if (seen.has(k)) {
          excluded = true;
          break;
        }
      }
      if (excluded) continue;
      eligible.push({
        ...row,
        score: applyListeningProfileAdjustment(row.score, row.artist),
        sourcePool: poolName,
      });
    }
    const deduped = preferBestSongVariants(eligible);
    return rankPoolCandidates(deduped, {
      entropy: options.entropy ?? null,
      temperature,
      pool: poolName,
    });
  };

  const queues: Record<AutoplayPoolName, AutoplayCandidate[]> = {
    related: filterAndPreparePool(pools.related, 'related'),
    discovery: filterAndPreparePool(pools.discovery, 'discovery'),
    local: filterAndPreparePool(pools.local, 'local'),
  };

  // Pre-fill the artist cap with the last 2 context artists so the next songs avoid them.
  const artistCounts = new Map<string, number>();
  const contextArtistList = options.contextArtists ? Array.from(options.contextArtists) : [];
  for (const rawArtist of contextArtistList.slice(-2)) {
    for (const key of extractArtistKeys(rawArtist)) {
      artistCounts.set(key, artistCap);
    }
  }

  const selected: AutoplayCandidate[] = [];
  let cursor = 0;
  let misses = 0;

  while (selected.length < limit && misses < sequence.length * 3) {
    const preferred = sequence[cursor % sequence.length];
    cursor += 1;
    const order: AutoplayPoolName[] = [
      preferred,
      ...PLANNER_POOLS.filter((p) => p !== preferred),
    ];

    let picked: AutoplayCandidate | null = null;

    for (const poolName of order) {
      const poolQueue = queues[poolName];
      while (poolQueue.length > 0) {
        const candidate = poolQueue.shift()!;
        const keys = candidateIdentityKeys(candidate);
        let duplicate = false;
        for (const k of keys) {
          if (seen.has(k)) {
            duplicate = true;
            break;
          }
        }
        if (duplicate) continue;

        const artists = extractArtistKeys(candidate.artist);
        let overCap = false;
        for (const artistKey of artists) {
          if ((artistCounts.get(artistKey) ?? 0) >= artistCap) {
            overCap = true;
            break;
          }
        }
        if (overCap) continue;

        picked = candidate;
        for (const k of keys) seen.add(k);
        for (const artistKey of artists) {
          artistCounts.set(artistKey, (artistCounts.get(artistKey) ?? 0) + 1);
        }
        break;
      }
      if (picked) break;
    }

    if (!picked) {
      misses += 1;
      continue;
    }
    misses = 0;
    selected.push(picked);
  }

  return selected;
}
