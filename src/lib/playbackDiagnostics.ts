export interface TransitionDiagnosticEntry {
  timestamp: string;
  from: string | null;
  to: string | null;
  visibilityAtEnded: DocumentVisibilityState | 'unknown';
  prewarmed: boolean;
  msToPlaying: number | null;
  error: string | null;
}

export const TRANSITION_LOG_STORAGE_KEY = 'xlab_transition_log';
const MAX_TRANSITION_ENTRIES = 30;

interface StoredTransitionRecord {
  id: number;
  entry: TransitionDiagnosticEntry;
}

let nextRecordId = 1;
const listeners = new Set<() => void>();

function loadInitialRecords(): StoredTransitionRecord[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(TRANSITION_LOG_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const valid: StoredTransitionRecord[] = [];
    for (const item of parsed.slice(-MAX_TRANSITION_ENTRIES)) {
      if (!item || typeof item !== 'object') continue;
      const obj = item as Partial<TransitionDiagnosticEntry>;
      if (typeof obj.timestamp !== 'string') continue;
      valid.push({
        id: nextRecordId++,
        entry: {
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
        },
      });
    }
    return valid;
  } catch {
    return [];
  }
}

let records: StoredTransitionRecord[] = loadInitialRecords();

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

export function recordTransitionDiagnostic(entry: TransitionDiagnosticEntry): number {
  const id = nextRecordId++;
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
    if (rec.id !== id) return rec;
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

export function getTransitionDiagnostics(): TransitionDiagnosticEntry[] {
  return records.map((r) => r.entry);
}

export function subscribeTransitionDiagnostics(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
