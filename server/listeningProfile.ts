// Listening signal rules adapted from Soundsible's ListeningLearning (MIT, (c) 2026 Arzuparreta)
import {
  getUserListeningEvents,
  LISTENING_EVENTS_MAX_PER_USER,
  type ListeningEventName,
  type ListeningEventRow,
} from './db.ts';

export const LISTENING_HALF_LIFE_DAYS = 14;

export const LISTENING_EVENT_WEIGHTS: Record<ListeningEventName, number> = {
  played_30s: 1,
  generated_completed: 1.5,
  generated_skipped_early: -2,
};

export const LISTENING_TOP_ARTISTS_LIMIT = 20;
export const LISTENING_RECENT_ARTISTS_LIMIT = 15;
export const LISTENING_SKIPPED_ARTISTS_LIMIT = 20;
export const LISTENING_SKIPPED_ARTIST_THRESHOLD = -0.75;

export interface ListeningTopArtist {
  artist: string;
  score: number;
}

export interface ListeningProfile {
  topArtists: ListeningTopArtist[];
  recentArtists: string[];
  skippedArtists: string[];
  tracksPlayed7d: number;
}

const GENERIC_ARTIST_KEYS = new Set([
  '',
  'unknown',
  'unknown artist',
  'various artists',
  'various',
  'va',
  'online',
  'youtube',
]);

export function normalizeListeningArtistKey(raw: string | null | undefined): string {
  const cleaned = String(raw ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s*[-–—]\s*topic$/i, '')
    .replace(/\s+official\s*(music\s*)?(channel|video|audio)?$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || GENERIC_ARTIST_KEYS.has(cleaned)) return '';
  return cleaned;
}

export function extractListeningArtistKeys(raw: string | null | undefined): string[] {
  const cleaned = String(raw ?? '').trim();
  if (!cleaned) return [];
  const parts = cleaned
    .split(/\s*(?:,|&|;|\/|\bx\b|\bfeat\.?\b|\bft\.?\b|\bfeaturing\b|\bwith\b)\s*/i)
    .map((part) => normalizeListeningArtistKey(part))
    .filter(Boolean);
  const fullKey = normalizeListeningArtistKey(cleaned);
  const out = new Set<string>(parts);
  if (fullKey && parts.length <= 1) {
    out.add(fullKey);
  }
  return Array.from(out);
}

export function parseListeningTimestampMs(raw: string | null | undefined): number {
  const text = String(raw ?? '').trim();
  if (!text) return 0;
  // SQLite datetime('now') produces 'YYYY-MM-DD HH:MM:SS' in UTC
  const normalized = text.includes('T') ? text : `${text.replace(' ', 'T')}Z`;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function buildListeningProfileFromEvents(
  events: ReadonlyArray<Pick<ListeningEventRow, 'event' | 'artist' | 'created_at'>>,
  nowMs = Date.now()
): ListeningProfile {
  const artistAgg = new Map<
    string,
    {
      display: string;
      score: number;
      lastPositiveMs: number;
    }
  >();

  const recentArtists: string[] = [];
  const recentArtistKeys = new Set<string>();
  let tracksPlayed7d = 0;

  // Sort newest-first so recentArtists reflects most recent listens even if input order varies
  const ordered = events
    .map((ev, idx) => ({ev, idx, createdMs: parseListeningTimestampMs(ev.created_at)}))
    .sort((a, b) => (b.createdMs !== a.createdMs ? b.createdMs - a.createdMs : a.idx - b.idx));

  for (const {ev, createdMs} of ordered) {
    const weight = LISTENING_EVENT_WEIGHTS[ev.event];
    if (typeof weight !== 'number') continue;

    const ageDays =
      createdMs > 0 ? Math.max(0, (nowMs - createdMs) / 86_400_000) : 0;

    if (ev.event === 'played_30s' && ageDays <= 7) {
      tracksPlayed7d += 1;
    }

    const rawArtist = String(ev.artist ?? '').trim();
    if (!rawArtist) continue;
    const primaryKey = normalizeListeningArtistKey(
      rawArtist.split(/\s*(?:,|&|;|\/|\bfeat\.?\b|\bft\.?\b|\bfeaturing\b|\bwith\b)\s*/i)[0] ||
        rawArtist
    );
    const displayArtist = (
      rawArtist.split(/\s*(?:,|&|;|\/|\bfeat\.?\b|\bft\.?\b|\bfeaturing\b|\bwith\b)\s*/i)[0] ||
      rawArtist
    )
      .replace(/\s*[-–—]\s*topic$/i, '')
      .trim();

    if (!primaryKey || !displayArtist) continue;

    const decayed = weight * Math.pow(0.5, ageDays / LISTENING_HALF_LIFE_DAYS);
    const existing = artistAgg.get(primaryKey);
    if (existing) {
      existing.score += decayed;
      if (weight > 0 && createdMs > existing.lastPositiveMs) {
        existing.lastPositiveMs = createdMs;
        existing.display = displayArtist;
      }
    } else {
      artistAgg.set(primaryKey, {
        display: displayArtist,
        score: decayed,
        lastPositiveMs: weight > 0 ? createdMs : 0,
      });
    }

    if (
      weight > 0 &&
      !recentArtistKeys.has(primaryKey) &&
      recentArtists.length < LISTENING_RECENT_ARTISTS_LIMIT
    ) {
      recentArtistKeys.add(primaryKey);
      recentArtists.push(displayArtist);
    }
  }

  const topArtists: ListeningTopArtist[] = Array.from(artistAgg.values())
    .filter((entry) => entry.score > 0)
    .sort((a, b) =>
      b.score !== a.score ? b.score - a.score : b.lastPositiveMs - a.lastPositiveMs
    )
    .slice(0, LISTENING_TOP_ARTISTS_LIMIT)
    .map((entry) => ({
      artist: entry.display,
      score: Math.round(entry.score * 1000) / 1000,
    }));

  const skippedArtists: string[] = Array.from(artistAgg.values())
    .filter((entry) => entry.score <= LISTENING_SKIPPED_ARTIST_THRESHOLD)
    .sort((a, b) => a.score - b.score)
    .slice(0, LISTENING_SKIPPED_ARTISTS_LIMIT)
    .map((entry) => entry.display);

  return {
    topArtists,
    recentArtists,
    skippedArtists,
    tracksPlayed7d,
  };
}

export function getListeningProfileForUser(userId: number): ListeningProfile {
  const rows = getUserListeningEvents(userId, LISTENING_EVENTS_MAX_PER_USER);
  return buildListeningProfileFromEvents(rows);
}
