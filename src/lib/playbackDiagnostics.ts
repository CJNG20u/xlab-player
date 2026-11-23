export type PlaybackPlatform = 'ios' | 'android' | 'other';
export type LifecycleDiagnosticType = 'hidden' | 'visible' | 'freeze' | 'resume';

export interface TransitionDiagnosticEntry {
  type: 'transition';
  timestamp: string;
  from: string | null;
  to: string | null;
  visibilityAtEnded: DocumentVisibilityState | 'unknown';
  prewarmed: boolean;
  msToPlaying: number | null;
  error: string | null;
  platform: PlaybackPlatform;
  audioSessionState: string | null;
  readyState: number | null;
  networkState: number | null;
  hasWebLock: boolean;
}

export interface LifecycleDiagnosticEntry {
  type: LifecycleDiagnosticType;
  timestamp: string;
  track: string | null;
  paused: boolean;
  currentTime: number;
  remainingQueue: number;
  secondsSinceHidden?: number | null;
  platform: PlaybackPlatform;
  audioSessionState: string | null;
  hasWebLock: boolean;
}

export type PlaybackDiagnosticEntry = TransitionDiagnosticEntry | LifecycleDiagnosticEntry;

export type TransitionDiagnosticInput = Omit<
  TransitionDiagnosticEntry,
  'type' | 'platform' | 'audioSessionState'
> &
  Partial<Pick<TransitionDiagnosticEntry, 'type' | 'platform' | 'audioSessionState'>>;

export type LifecycleDiagnosticInput = Omit<
  LifecycleDiagnosticEntry,
  'platform' | 'audioSessionState'
> &
  Partial<Pick<LifecycleDiagnosticEntry, 'platform' | 'audioSessionState'>>;

export const TRANSITION_LOG_STORAGE_KEY = 'xlab_transition_log';
const MAX_TRANSITION_ENTRIES = 30;

interface StoredDiagnosticRecord {
  id: number;
  entry: PlaybackDiagnosticEntry;
}

export function detectPlaybackPlatform(): PlaybackPlatform {
  try {
    if (typeof navigator === 'undefined') return 'other';
    const ua = navigator.userAgent || '';
    if (/android/i.test(ua)) return 'android';
    const platform = navigator.platform || '';
    const maxTouchPoints = typeof navigator.maxTouchPoints === 'number' ? navigator.maxTouchPoints : 0;
    if (/iphone|ipad|ipod/i.test(ua) || (platform === 'MacIntel' && maxTouchPoints > 1)) {
      return 'ios';
    }
    return 'other';
  } catch {
    return 'other';
  }
}

export function getAudioSessionState(): string | null {
  try {
    if (typeof navigator === 'undefined') return null;
    const audioSession = (
      navigator as Navigator & {audioSession?: {state?: unknown}}
    ).audioSession;
    if (audioSession && typeof audioSession.state === 'string') {
      return audioSession.state;
    }
    return null;
  } catch {
    return null;
  }
}

let nextRecordId = 1;
const listeners = new Set<() => void>();

function isValidPlatform(val: unknown): val is PlaybackPlatform {
  return val === 'ios' || val === 'android' || val === 'other';
}

function isLifecycleType(val: unknown): val is LifecycleDiagnosticType {
  return val === 'hidden' || val === 'visible' || val === 'freeze' || val === 'resume';
}

function loadInitialRecords(): StoredDiagnosticRecord[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(TRANSITION_LOG_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const valid: StoredDiagnosticRecord[] = [];
    for (const item of parsed.slice(-MAX_TRANSITION_ENTRIES)) {
      if (!item || typeof item !== 'object') continue;
      const obj = item as Record<string, unknown>;
      if (typeof obj.timestamp !== 'string') continue;

      if (isLifecycleType(obj.type)) {
        const entry: LifecycleDiagnosticEntry = {
          type: obj.type,
          timestamp: obj.timestamp,
          track: typeof obj.track === 'string' ? obj.track : null,
          paused: Boolean(obj.paused),
          currentTime:
            typeof obj.currentTime === 'number' && Number.isFinite(obj.currentTime)
              ? obj.currentTime
              : 0,
          remainingQueue:
            typeof obj.remainingQueue === 'number' && Number.isFinite(obj.remainingQueue)
              ? Math.max(0, Math.floor(obj.remainingQueue))
              : 0,
          platform: isValidPlatform(obj.platform) ? obj.platform : 'other',
          audioSessionState:
            typeof obj.audioSessionState === 'string' ? obj.audioSessionState : null,
          hasWebLock: Boolean(obj.hasWebLock),
        };
        if (obj.type === 'visible') {
          entry.secondsSinceHidden =
            typeof obj.secondsSinceHidden === 'number' && Number.isFinite(obj.secondsSinceHidden)
              ? obj.secondsSinceHidden
              : null;
        }
        valid.push({id: nextRecordId++, entry});
        continue;
      }

      valid.push({
        id: nextRecordId++,
        entry: {
          type: 'transition',
          timestamp: obj.timestamp,
          from: typeof obj.from === 'string' ? obj.from : null,
          to: typeof obj.to === 'string' ? obj.to : null,
          visibilityAtEnded:
            obj.visibilityAtEnded === 'visible' || obj.visibilityAtEnded === 'hidden'
              ? obj.visibilityAtEnded
              : 'unknown',
          prewarmed: Boolean(obj.prewarmed),
          msToPlaying:
            typeof obj.msToPlaying === 'number' && Number.isFinite(obj.msToPlaying)
              ? obj.msToPlaying
              : null,
          error: typeof obj.error === 'string' ? obj.error : null,
          platform: isValidPlatform(obj.platform) ? obj.platform : 'other',
          audioSessionState:
            typeof obj.audioSessionState === 'string' ? obj.audioSessionState : null,
          readyState:
            typeof obj.readyState === 'number' && Number.isFinite(obj.readyState)
              ? obj.readyState
              : null,
          networkState:
            typeof obj.networkState === 'number' && Number.isFinite(obj.networkState)
              ? obj.networkState
              : null,
          hasWebLock: Boolean(obj.hasWebLock),
        },
      });
    }
    return valid;
  } catch {
    return [];
  }
}

let records: StoredDiagnosticRecord[] = loadInitialRecords();

function mirrorToStorage(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      TRANSITION_LOG_STORAGE_KEY,
      JSON.stringify(records.map((r) => r.entry))
    );
  } catch {
    // Ignore storage quota or private-browsing errors
  }
}

function notifyListeners(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function recordTransitionDiagnostic(input: TransitionDiagnosticInput): number {
  const id = nextRecordId++;
  const entry: TransitionDiagnosticEntry = {
    ...input,
    type: 'transition',
    platform: input.platform ?? detectPlaybackPlatform(),
    audioSessionState:
      input.audioSessionState !== undefined ? input.audioSessionState : getAudioSessionState(),
  };
  records = [...records, {id, entry}].slice(-MAX_TRANSITION_ENTRIES);
  mirrorToStorage();
  notifyListeners();
  return id;
}

export function recordLifecycleDiagnostic(input: LifecycleDiagnosticInput): number {
  const id = nextRecordId++;
  const entry: LifecycleDiagnosticEntry = {
    ...input,
    platform: input.platform ?? detectPlaybackPlatform(),
    audioSessionState:
      input.audioSessionState !== undefined ? input.audioSessionState : getAudioSessionState(),
  };
  records = [...records, {id, entry}].slice(-MAX_TRANSITION_ENTRIES);
  mirrorToStorage();
  notifyListeners();
  return id;
}

export function updateTransitionDiagnostic(
  id: number,
  patch: Partial<Pick<TransitionDiagnosticEntry, 'msToPlaying' | 'error'>>
): void {
  let changed = false;
  records = records.map((rec) => {
    if (rec.id !== id || rec.entry.type !== 'transition') return rec;
    changed = true;
    return {
      ...rec,
      entry: {
        ...rec.entry,
        ...patch,
      },
    };
  });
  if (!changed) return;
  mirrorToStorage();
  notifyListeners();
}

export function getTransitionDiagnostics(): PlaybackDiagnosticEntry[] {
  return records.map((r) => r.entry);
}

export function subscribeTransitionDiagnostics(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
